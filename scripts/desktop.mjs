import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (process.platform !== "darwin")
  throw new Error("桌面浮窗目前支持 macOS；其他系统可打开 /pet/ 独立网页。");
const dir = path.join(root, ".desktop");
fs.mkdirSync(dir, { recursive: true });
const bundle = path.join(dir, "YiWorkPet.app", "Contents");
fs.mkdirSync(path.join(bundle, "MacOS"), { recursive: true });
fs.writeFileSync(
  path.join(bundle, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>work.yi.companion</string><key>CFBundleName</key><string>YiWorkPet</string><key>CFBundleExecutable</key><string>YiWorkPet</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>`,
);
const executable = path.join(bundle, "MacOS", "YiWorkPet");
const built = spawnSync(
  "swiftc",
  [
    "-module-cache-path",
    path.join(dir, "module-cache"),
    path.join(root, "desktop/Pet.swift"),
    "-o",
    executable,
    "-framework",
    "Cocoa",
    "-framework",
    "WebKit",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) process.exit(built.status ?? 1);
if (process.argv.includes("--build-only")) {
  console.log("桌面小艺已编译：" + executable);
  process.exit(0);
}
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT 无效");
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (!response.ok) throw new Error();
} catch {
  throw new Error("请先运行 npm start，确保本地服务已启动。");
}
const url = new URL(`http://127.0.0.1:${port}/pet/?native=1`);
const sid = process.argv.find((a) => a.startsWith("--session="))?.slice(10);
if (sid) url.searchParams.set("session", sid);
const child = spawn(executable, [url.href], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
