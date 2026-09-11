import { spawn } from "node:child_process";
import { loadEnv } from "../server/core.mjs";
loadEnv();
const children = [
  spawn(process.execPath, ["server/index.mjs"], { stdio: "inherit" }),
  spawn("npm", ["--prefix", "web", "run", "dev", "--", "--host", "127.0.0.1", "--port", "4318"], {
    stdio: "inherit",
  }),
];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => process.exit(code), 3000);
  timer.unref();
  Promise.all(
    children.map((child) =>
      child.exitCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.on("exit", resolve)),
    ),
  ).then(() => process.exit(code));
}
for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!closing) stop(code ?? 1);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
