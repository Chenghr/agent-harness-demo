import { spawnSync } from "node:child_process";
import path from "node:path";

// Keep the Node selected at the project root when checking the frontend package.
const env = {
  ...process.env,
  PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
};
for (const [cwd, args] of [
  [".", ["web/node_modules/oxlint/bin/oxlint", "server", "scripts", "test"]],
  ["web", ["node_modules/oxlint/bin/oxlint", "app", "vite.config.ts", "next.config.ts"]],
]) {
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
