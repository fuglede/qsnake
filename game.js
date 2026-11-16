// Host only: prepare input bits, execute QASM, paint measured display planes.
// Movement, growth, collisions, food, RNG, and terminal states live in snake.qasm.
import { parseQASM, BasisStateSimulator } from "./interpreter.js";

const canvas = document.querySelector("canvas");
const context = canvas.getContext("2d");
let machine, metadata, frame;
let mode = "loading";
let lastTick = 0;
const pendingKeys = [];
const number = bits => bits.reduce((sum, bit, i) => sum + bit * (2 ** i), 0);

function seed() {
  const random = crypto.getRandomValues(new Uint16Array(1))[0];
  machine.writeRegister("seed", Array.from({ length: 16 }, (_, i) => (random >>> i) & 1));
}

function execute(direction, restart = false) {
  machine.writeRegister("input", [
    (direction ?? 0) & 1, ((direction ?? 0) >>> 1) & 1,
    direction === undefined ? 0 : 1, restart ? 1 : 0,
  ]);
  machine.run();
  frame = {
    body: machine.readClassical("body"),
    head: machine.readClassical("head_pixels"),
    food: machine.readClassical("food_pixels"),
    status: machine.readClassical("result"),
    length: number(machine.readClassical("size")),
  };
  if (frame.status[1] || frame.status[2]) {
    mode = "ended";
    pendingKeys.length = 0;
  }
}

function restart() {
  pendingKeys.length = 0;
  seed();
  execute(undefined, true);
  mode = "ready";
  draw();
}

function start(direction) {
  if (!machine) return;
  canvas.focus({ preventScroll: true });
  if (mode === "ended") restart();
  mode = "playing";
  execute(direction);
  lastTick = performance.now();
  draw();
}

function requestDirection(direction) {
  if (!machine) return;
  if (mode === "ready" || mode === "ended") start(direction);
  else if (mode === "paused") {
    pendingKeys.length = 0;
    start(direction);
  } else if (pendingKeys.length < 2) pendingKeys.push(direction);
}

function pause() {
  if (mode !== "playing") return;
  mode = "paused";
  pendingKeys.length = 0;
  draw();
}

function overlay(title, lines = []) {
  const { width, height } = canvas;
  context.fillStyle = "rgba(16, 24, 16, 0.82)";
  context.fillRect(0, height / 2 - 65, width, 130);
  context.fillStyle = "#e7efdf";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "21px ui-monospace, monospace";
  context.fillText(title, width / 2, height / 2 - (lines.length ? 25 : 0));
  context.fillStyle = "#a4b49a";
  context.font = "13px ui-monospace, monospace";
  lines.forEach((text, i) => context.fillText(text, width / 2, height / 2 + 8 + 23 * i));
}

function draw() {
  const { width, height } = canvas;
  context.fillStyle = "#101810";
  context.fillRect(0, 0, width, height);
  if (frame) {
    const dx = width / metadata.width, dy = height / metadata.height;
    context.strokeStyle = "#192219";
    context.lineWidth = 1;
    context.beginPath();
    for (let x = 1; x < metadata.width; x++) {
      context.moveTo(x * dx + 0.5, 0); context.lineTo(x * dx + 0.5, height);
    }
    for (let y = 1; y < metadata.height; y++) {
      context.moveTo(0, y * dy + 0.5); context.lineTo(width, y * dy + 0.5);
    }
    context.stroke();
    for (let i = 0; i < frame.body.length; i++) {
      const x = (i % metadata.width) * dx, y = Math.floor(i / metadata.width) * dy;
      if (frame.body[i]) {
        context.fillStyle = frame.head[i] ? "#d9efc1" : "#8bc879";
        context.fillRect(x + 2, y + 2, dx - 4, dy - 4);
      }
      if (frame.food[i]) {
        context.fillStyle = "#e6a078";
        context.fillRect(x + 6, y + 6, dx - 12, dy - 12);
      }
    }
  }
  if (mode === "loading") overlay("Loading circuit…");
  if (mode === "ready") overlay("Click or press Enter to start", ["Arrow keys / WASD / swipe to steer", "Space or tap to pause"]);
  if (mode === "paused") overlay("Paused", ["Space or tap to resume"]);
  if (mode === "ended") overlay(frame.status[2] ? "You filled the board" : "Game over", [
    `Score ${frame.length - metadata.initialLength}`, "Enter or tap to restart",
  ]);
  if (mode === "error") overlay("Could not load the circuit", ["Reload the page to try again"]);
  const state = mode === "ended" ? (frame.status[2] ? "won" : "game over") : mode;
  canvas.setAttribute("aria-label", `Snake, ${state}. Arrow keys or WASD to move, space to pause, Enter to restart. Swipe to move, tap to pause.`);
}

const directions = new Map([
  ["ArrowRight", 0], ["d", 0], ["D", 0], ["ArrowDown", 1], ["s", 1], ["S", 1],
  ["ArrowLeft", 2], ["a", 2], ["A", 2], ["ArrowUp", 3], ["w", 3], ["W", 3],
]);
window.addEventListener("keydown", event => {
  if (!machine || event.ctrlKey || event.metaKey || event.altKey || event.target?.closest?.("a")) return;
  if (!directions.has(event.key) && ![" ", "Enter", "r", "R"].includes(event.key)) return;
  event.preventDefault();
  if (event.repeat) return;
  if (directions.has(event.key)) requestDirection(directions.get(event.key));
  else if (event.key === "r" || event.key === "R" || event.key === "Enter" && mode === "ended") restart();
  else if (mode === "playing") pause();
  else start();
});

let gesture;
let suppressClick = false;
canvas.addEventListener("pointerdown", event => {
  if (!event.isPrimary || event.button !== 0) return;
  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture?.(event.pointerId);
  suppressClick = false;
  gesture = { x: event.clientX, y: event.clientY, id: event.pointerId };
});
canvas.addEventListener("pointerup", event => {
  if (!gesture || gesture.id !== event.pointerId || !machine) return;
  const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
  gesture = undefined;
  if (Math.max(Math.abs(dx), Math.abs(dy)) >= 12) {
    suppressClick = true;
    requestDirection(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3));
  }
});
canvas.addEventListener("click", () => {
  if (suppressClick) { suppressClick = false; return; }
  if (!machine) return;
  if (mode === "ended") restart();
  else if (mode === "playing") pause();
  else start();
});
canvas.addEventListener("pointercancel", () => { gesture = undefined; });
window.addEventListener("blur", pause);
document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });

function animate(now) {
  if (mode === "playing" && now - lastTick >= metadata.tickMs) {
    execute(pendingKeys.shift());
    lastTick = now;
    draw();
  }
  requestAnimationFrame(animate);
}

draw();
try {
  // The generated page carries the exact linked QASM as inert JSON data.
  // Startup therefore also works offline and under file://, without module
  // imports, extra authenticated asset requests, or a running local server.
  const embedded = document.getElementById("snake-qasm");
  if (!embedded) throw new Error("The page is missing its embedded QASM circuit");
  const source = JSON.parse(embedded.textContent);
  metadata = JSON.parse(source.match(/^\/\/ @snake (.+)$/m)[1]);
  const program = parseQASM(source);
  machine = new BasisStateSimulator(program);
  const heading = `Snake with ${program.qubitCount.toLocaleString("en-US")} qubits and ${program.gateCount.toLocaleString("en-US")} gates`;
  document.querySelector("h1").textContent = "Snake";
  document.title = heading;
  seed();
  execute();
  mode = "ready";
  draw();
  canvas.focus({ preventScroll: true });
  requestAnimationFrame(animate);
} catch (error) {
  console.error(error);
  machine = undefined;
  mode = "error";
  draw();
}
