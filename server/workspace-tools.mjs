import fs from "node:fs";
import path from "node:path";
import { HarnessError, id } from "./core.mjs";
import { photoSandboxRule } from "./privacy-policy.mjs";
const string = { type: "string", maxLength: 200000 };
const tool = (name, description, properties, required) => ({
  name,
  title: description,
  description,
  kind: "tool",
  source: "local",
  version: "1",
  category: "工作区操作",
  simulated: false,
  parameters: { type: "object", properties, required, additionalProperties: false },
});
export const WORKSPACE_TOOLS = [
  tool("file_search", "在工作区文本中搜索关键词", { query: { ...string, maxLength: 200 } }, [
    "query",
  ]),
  tool(
    "file_edit",
    "精确替换文件中的唯一一段原文；原文不匹配时拒绝修改",
    { path: string, oldText: string, newText: string },
    ["path", "oldText", "newText"],
  ),
  tool("file_delete", "删除一个普通文件，工作区内文件可以从本轮记录恢复", { path: string }, [
    "path",
  ]),
  tool(
    "shell_run",
    "执行本次任务所需的终端命令；可能需要批准。默认权限在 macOS 沙箱中执行，禁止网络和工作区外写入",
    {
      command: { ...string, maxLength: 12000 },
      timeout: { type: "integer", minimum: 1000, maximum: 120000 },
      access: {
        type: "string",
        enum: ["workspace", "full"],
        description: "默认 workspace。需要网络或工作区外操作时明确申请 full，由用户单次批准。",
      },
    },
    ["command"],
  ),
];
const fail = (message) => {
  throw new HarnessError("POLICY_DENIED", message);
};
export function sandboxCommand(root, storage, command, mode, extraDeny = [], apiPorts = []) {
  root = fs.realpathSync(root);
  storage = fs.realpathSync(storage);
  const localApiDeny = apiPorts.map(port => `(deny network-outbound (remote ip "localhost:${Number(port)}"))`).join(" ");
  if (mode === "full") {
    if (process.platform === "darwin")
      return {
        executable: "/usr/bin/sandbox-exec",
        args: [
          "-p",
          `(version 1) (allow default) (deny file-read* file-write* (subpath ${JSON.stringify(storage)})) ${photoSandboxRule} ${localApiDeny}`,
          "/bin/sh",
          "-c",
          command,
        ],
      };
    return { executable: "/bin/sh", args: ["-c", command] };
  }
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec"))
    fail("此系统尚未提供受限命令沙箱；请使用文件工具，或显式选择完全访问权限");
  const q = (s) => JSON.stringify(s);
  const allowed = [root];
  const profile = `(version 1) (deny default) (allow process*) (allow sysctl-read) (allow mach-lookup) (allow file-read-metadata) (allow file-read* (literal "/") (subpath "/private/var/db/dyld") (subpath ${q(root)}) (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") (subpath "/opt") (subpath "/dev")) (deny network*) (allow file-write* ${allowed.map((p) => `(subpath ${q(p)})`).join(" ")}) (deny file-read* file-write* (subpath ${q(storage)}) ${extraDeny.map((p) => `(subpath ${q(p)})`).join(" ")}) (deny file-write* (regex #"/\\.git(/|$)")) (deny file-read* file-write* (regex #"/(\\.env([^/]*$)|\\.ssh/|\\.aws/|\\.gnupg/)"))`;
  return { executable: "/usr/bin/sandbox-exec", args: ["-p", profile + " " + photoSandboxRule, "/bin/sh", "-c", command] };
}
export async function executeWorkspaceTool(h, s, a, name, args, signal, epoch, action) {
  if (name === "file_list") return { files: h.workspaces.files(s.workspaceId) };
  if (name === "file_search") {
    const matches = [];
    let scanned = 0;
    for (const f of h.workspaces.files(s.workspaceId)) {
      if (matches.length >= 100 || scanned >= 500) break;
      const p = h.permissions.path(s, a, f).file;
      if (fs.statSync(p).size > 2_000_000) continue;
      const bytes = fs.readFileSync(p);
      if (bytes.includes(0)) continue;
      scanned++;
      for (const [i, line] of bytes.toString().split("\n").entries())
        if (line.includes(args.query)) {
          matches.push({ path: f, line: i + 1, text: line.slice(0, 500) });
          if (matches.length >= 100) break;
        }
    }
    return { matches, scanned, truncated: matches.length >= 100 || scanned >= 500 };
  }
  if (name === "shell_run") {
    h.valid(s, a, epoch, signal);
    if (action.authorizedGrantVersion !== s.grantVersion) fail("权限已改变，命令没有执行");
    const beforeCommand = h.workspaces.snapshot(s.workspaceId, "Before command");
    for (const file of Object.keys(beforeCommand.manifest))
      h.workspaces.assertExpected(s.workspaceId, s.id, file);
    const spec = sandboxCommand(
      s.workspace,
      h.store.root,
      args.command,
      args.access === "full" ? "full" : s.permissionMode,
      [],
      [...h.apiPorts],
    );
    let result;
    try {
      result = await h.processes.run({
        sessionId: s.id,
        agentId: a.id,
        cwd: s.workspace,
        ...spec,
        signal,
        timeout: args.timeout ?? 30000,
      });
    } finally {
      if (!h.processes.list(s.id).length) {
        const afterCommand = h.workspaces.snapshot(s.workspaceId, "After command");
        for (const change of h.workspaces.diff(beforeCommand.manifest, afterCommand.manifest))
          h.workspaces.recordChange(s.workspaceId, s.id, change.path);
      }
      s.workspaceRevision++;
    }
    return result;
  }
  const location = h.permissions.path(s, a, args.path),
    file = location.file;
  if (name === "file_read") {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      throw new HarnessError("NOT_FOUND", "文件不存在");
    if (fs.statSync(file).size > 10 * 1024 * 1024) fail("文件超过 10 MB，请使用命令或缩小文件");
    const content = fs.readFileSync(file, "utf8");
    if (content.length > 12000) {
      const artifact = h.artifact(s, path.basename(file), content, a.id);
      return { content: content.slice(0, 12000), artifactId: artifact.id, truncated: true };
    }
    return { path: args.path, content };
  }
  if (!["file_write", "file_edit", "file_delete"].includes(name)) return undefined;
  h.valid(s, a, epoch, signal);
  if (action.authorizedGrantVersion !== s.grantVersion) fail("授权已改变，修改没有执行");
  if (fs.existsSync(file) && !fs.statSync(file).isFile()) fail("只能修改普通文件");
  if (location.inside) h.workspaces.assertExpected(s.workspaceId, s.id, location.relative);
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (name === "file_delete") {
    if (before === null) throw new HarnessError("NOT_FOUND", "文件不存在");
    fs.unlinkSync(file);
  } else {
    let content = args.content;
    if (name === "file_edit") {
      if (before === null || !args.oldText || before.split(args.oldText).length !== 2)
        throw new HarnessError("EDIT_CONFLICT", "原文必须在文件中恰好出现一次，请重新读取文件");
      content = before.replace(args.oldText, () => args.newText);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + "." + id("write") + ".tmp";
    try {
      fs.writeFileSync(temp, content, {
        flag: "wx",
        mode: fs.existsSync(file) ? fs.statSync(file).mode : 0o644,
      });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  if (location.inside) h.workspaces.recordChange(s.workspaceId, s.id, location.relative);
  s.workspaceRevision++;
  return {
    path: args.path,
    status: "ok",
    workspaceRevision: s.workspaceRevision,
    rollbackCovered: location.inside && !["shell_run"].includes(name),
  };
}
