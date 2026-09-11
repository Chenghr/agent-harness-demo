import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const build = spawnSync("npm", ["--prefix", "web", "run", "build"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const candidates = ["web/out", "web/dist/client", "web/dist"];
const source = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
if (!source)
  throw new Error("静态导出缺少 index.html；请检查 web/next.config.ts 的 output: export");
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist", { recursive: true });
fs.cpSync(source, "dist", { recursive: true });
console.log(`本地前端已构建到 dist/；运行 npm start 后打开 http://127.0.0.1:4317`);
