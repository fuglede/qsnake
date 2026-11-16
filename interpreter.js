/**
 * Exact computational-basis interpreter for a subset of OpenQASM 2.0.
 *
 * Gates: x (NOT), cx (CNOT), ccx (Toffoli).
 * I/O: reset, measure; register-wide operations and barrier are supported.
 * Each qubit is one byte, always 0 or 1. There is no state vector, sampling,
 * eval, game-specific opcode, or approximation. Unsupported QASM is rejected.
 * Gate counts count expanded x/cx/ccx operations, excluding reset/measurement.
 */
const X = 1, CX = 2, CCX = 3, RESET = 4, MEASURE = 5;

export function parseQASM(source) {
  if (typeof source !== "string") throw new TypeError("QASM source must be a string");
  // Strip comments while preserving newlines for useful error locations.
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, text => text.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
  if (clean.includes("/*")) throw new SyntaxError("Unterminated QASM comment");
  const qregs = Object.create(null), cregs = Object.create(null);
  const instructions = [];
  let qubitCount = 0, classicalBitCount = 0, gateCount = 0;
  let header = false, library = false, executable = false, position = 0;
  for (const chunk of clean.split(";")) {
    const statement = chunk.trim();
    const start = position;
    position += chunk.length + 1;
    if (!statement) continue;
    const fail = message => {
      const line = clean.slice(0, start + chunk.indexOf(statement)).split("\n").length;
      throw new SyntaxError(`${message} (line ${line}): ${statement.slice(0, 100)}`);
    };
    if (position > clean.length) fail("Missing semicolon");
    if (!header) {
      if (statement !== "OPENQASM 2.0") fail("Expected OPENQASM 2.0 header");
      header = true;
      continue;
    }
    if (/^include\b/.test(statement)) {
      if (statement !== 'include "qelib1.inc"' || library || executable) fail("Only one qelib1.inc include is supported, before operations");
      library = true;
      continue;
    }
    const declaration = statement.match(/^(qreg|creg)\s+([a-z][A-Za-z0-9_]*)\s*\[\s*(\d+)\s*\]$/);
    if (declaration) {
      if (executable) fail("Registers must be declared before operations");
      const [, kind, name, count] = declaration;
      const size = Number(count);
      if (!Number.isSafeInteger(size) || size < 1 || size > 1_000_000) fail("Invalid register size");
      if (qregs[name] || cregs[name]) fail("Duplicate register");
      const registers = kind === "qreg" ? qregs : cregs;
      const offset = kind === "qreg" ? qubitCount : classicalBitCount;
      registers[name] = Object.freeze({ offset, size });
      if (kind === "qreg") qubitCount += size;
      else classicalBitCount += size;
      continue;
    }
    executable = true;
    const resolve = (text, registers) => {
      const match = text.trim().match(/^([a-z][A-Za-z0-9_]*)(?:\s*\[\s*(\d+)\s*\])?$/);
      if (!match || !registers[match[1]]) fail("Unknown register or invalid operand");
      const { offset, size } = registers[match[1]];
      if (match[2] === undefined) return Array.from({ length: size }, (_, i) => offset + i);
      const index = Number(match[2]);
      if (!Number.isSafeInteger(index) || index >= size) fail("Register index out of bounds");
      return [offset + index];
    };
    const emit = (op, a, b = 0, c = 0) => instructions.push(op, a, b, c);
    const measurement = statement.match(/^measure\s+(.+?)\s*->\s*(.+)$/);
    if (measurement) {
      const from = resolve(measurement[1], qregs), to = resolve(measurement[2], cregs);
      if (from.length !== to.length) fail("Measurement register sizes differ");
      for (let i = 0; i < from.length; i++) emit(MEASURE, from[i], to[i]);
      continue;
    }
    const reset = statement.match(/^reset\s+(.+)$/);
    if (reset) {
      for (const bit of resolve(reset[1], qregs)) emit(RESET, bit);
      continue;
    }
    const barrier = statement.match(/^barrier\s+(.+)$/);
    if (barrier) {
      for (const operand of barrier[1].split(",")) resolve(operand, qregs);
      continue;
    }
    const gate = statement.match(/^(x|cx|ccx)\s+(.+)$/);
    if (!gate) fail("Unsupported operation; allowed gates are x, cx, ccx, with reset/measure/barrier");
    if (!library) fail("x/cx/ccx require include \"qelib1.inc\"");
    const op = { x: X, cx: CX, ccx: CCX }[gate[1]];
    const operands = gate[2].split(",").map(text => resolve(text, qregs));
    if (operands.length !== op) fail("Wrong number of gate operands");
    const width = Math.max(...operands.map(bits => bits.length));
    if (operands.some(bits => bits.length !== 1 && bits.length !== width)) fail("Gate register sizes differ");
    for (let i = 0; i < width; i++) {
      const bits = operands.map(bits => bits.length === 1 ? bits[0] : bits[i]);
      if (new Set(bits).size !== bits.length) fail("Gate operands must be distinct qubits");
      emit(op, ...bits);
      gateCount++;
    }
  }
  if (!header || qubitCount === 0) throw new SyntaxError("QASM must declare a header and qubits");
  return Object.freeze({
    qregs: Object.freeze(qregs), cregs: Object.freeze(cregs), qubitCount, classicalBitCount,
    gateCount, instructions: new Uint32Array(instructions),
  });
}

export class BasisStateSimulator {
  constructor(program) {
    this.program = program;
    this.qubits = new Uint8Array(program.qubitCount);
    this.classical = new Uint8Array(program.classicalBitCount);
  }

  /** External input preparation. Bits use the register's little-endian order. */
  writeRegister(name, bits) {
    const register = this.program.qregs[name];
    if (!register) throw new RangeError(`Unknown quantum register: ${name}`);
    if (bits.length !== register.size || Array.from(bits).some(bit => bit !== 0 && bit !== 1)) {
      throw new RangeError(`Expected ${register.size} binary bits for ${name}`);
    }
    this.qubits.set(bits, register.offset);
  }

  /** Return a snapshot of a quantum register (useful for debugging). */
  readRegister(name) {
    const register = this.program.qregs[name];
    if (!register) throw new RangeError(`Unknown quantum register: ${name}`);
    return this.qubits.slice(register.offset, register.offset + register.size);
  }

  /** Return the most recent measurements of a classical output register. */
  readClassical(name) {
    const register = this.program.cregs[name];
    if (!register) throw new RangeError(`Unknown classical register: ${name}`);
    return this.classical.slice(register.offset, register.offset + register.size);
  }

  /** Execute the whole program once, preserving state between executions. */
  run() {
    const q = this.qubits, c = this.classical, code = this.program.instructions;
    for (let pc = 0; pc < code.length; pc += 4) {
      const a = code[pc + 1], b = code[pc + 2], target = code[pc + 3];
      switch (code[pc]) {
        case X: q[a] ^= 1; break;
        case CX: q[b] ^= q[a]; break;
        case CCX: q[target] ^= q[a] & q[b]; break;
        case RESET: q[a] = 0; break;
        case MEASURE: c[b] = q[a]; break;
      }
    }
    return this;
  }
}
