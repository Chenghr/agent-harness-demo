import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint } from "./runtime/capabilities/repository.ts";
import { HarnessError } from "./core.mjs";
import { validateTool } from "./tool-schema.mjs";

const configRoot = fileURLToPath(new URL("../config/tools/", import.meta.url));
const scriptRoot = fileURLToPath(new URL("./commands/", import.meta.url));
/** Only startup configuration in this application can create an executable binding. */
export function configuredCommands(root) {
  const commands = [];
  for (const name of fs.readdirSync(configRoot).filter((n) => n.endsWith(".json"))) {
    const config = JSON.parse(fs.readFileSync(path.join(configRoot, name), "utf8"));
    if (!/^[a-z][a-z0-9_]{1,60}$/.test(config.name) || !/^[a-z0-9-]+\.mjs$/.test(config.script))
      throw new HarnessError("INVALID_ARGUMENT", "本地命令配置名称或脚本路径不合法");
    const code = fs.readFileSync(path.join(scriptRoot, config.script), "utf8");
    const version = fingerprint([config, code]),
      directory = path.join(root, "commands");
    fs.mkdirSync(directory, { recursive: true });
    const entry = path.join(directory, `${version}.mjs`);
    if (!fs.existsSync(entry)) fs.writeFileSync(entry, code, { flag: "wx" });
    commands.push({
      ...config,
      kind: "tool",
      category: "文本处理",
      source: "local-config",
      version,
      simulated: false,
      adapter: "node-command-v1",
      binding: { entry, digest: fingerprint(code) },
    });
  }
  return commands;
}
export async function executeCommand(h, s, a, definition, args, signal) {
  validateTool(definition.parameters, args);
  const binding = definition.binding;
  if (!binding || fingerprint(fs.readFileSync(binding.entry, "utf8")) !== binding.digest)
    throw new HarnessError("EXECUTION_VERSION_CHANGED", "固定的命令代码发生变化，未执行");
  const result = await h.processes.run({
    sessionId: s.id,
    agentId: a.id,
    cwd: h.workspace(s, a),
    args: [binding.entry, JSON.stringify(args)],
    signal,
    timeout: 15000,
  });
  if (result.exitCode !== 0) throw new HarnessError("COMMAND_FAILED", "固定命令未成功结束", result);
  try {
    return {
      status: "ok",
      version: definition.version,
      data: JSON.parse(result.output),
      cleanup: result.cleanup,
    };
  } catch {
    throw new HarnessError("COMMAND_OUTPUT", "命令结果不是约定的 JSON");
  }
}
