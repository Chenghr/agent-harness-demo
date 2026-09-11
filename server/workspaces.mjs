import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { HarnessError, id, now, safePath } from "./core.mjs";
import { privateJson } from "./settings/models.mjs";

export const excludedPath = (file) =>
  file
    .split(/[\\/]/)
    .some(
      (p) =>
        [
          ".git",
          ".harness",
          ".desktop",
          "node_modules",
          ".next",
          ".vinext",
          "dist",
          "coverage",
          ".ssh",
          ".aws",
          ".gnupg",
        ].includes(p) ||
        /^\.env(?:\.|$)/.test(p) ||
        /\.(?:pem|key|p12|pfx)$/.test(p),
    );
const problem = (code, message, details) => {
  throw new HarnessError(code, message, details);
};
const read = (file, fallback) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
const gitEnv = () => ({
  PATH: process.env.PATH,
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Harness",
  GIT_AUTHOR_EMAIL: "harness@localhost",
  GIT_COMMITTER_NAME: "Harness",
  GIT_COMMITTER_EMAIL: "harness@localhost",
});
/** Private Git object storage; never stages, commits or resets the user's repository. */
export class WorkspaceManager {
  constructor(root, { protectedRoots = [] } = {}) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(this.root);
    this.protectedRoots = [this.root, ...protectedRoots.map((p) => fs.realpathSync(p))];
    this.file = path.join(this.root, "workspaces.json");
    this.items = read(this.file, []);
    this.owners = new Map();
  }
  save() {
    privateJson(this.file, this.items);
  }
  list() {
    return this.items.map((p) => ({ ...p, activeSession: this.owners.get(p.id) ?? null }));
  }
  get(wid) {
    return this.items.find((p) => p.id === wid) ?? problem("NOT_FOUND", "工作区不存在");
  }
  git(w, args, input) {
    return execFileSync("git", ["--git-dir=" + path.join(this.root, w.id, "git"), ...args], {
      input,
      env: gitEnv(),
      timeout: 20000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  add(directory) {
    if (typeof directory !== "string" || !path.isAbsolute(directory))
      problem("INVALID_ARGUMENT", "请选择本机文件夹或填写绝对路径");
    const target = fs.realpathSync(directory);
    if (!fs.statSync(target).isDirectory() || target === path.parse(target).root)
      problem("INVALID_ARGUMENT", "不能使用此工作目录");
    if (this.protectedRoots.some((p) => target === p || target.startsWith(p + path.sep)))
      problem("INVALID_ARGUMENT", "不能将应用记录目录作为工作区");
    const existing = this.items.find((p) => p.path === target);
    if (existing) return existing;
    const w = { id: id("workspace"), name: path.basename(target), path: target, createdAt: now() };
    const store = path.join(this.root, w.id);
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
    execFileSync("git", ["init", "--bare", "-q", path.join(store, "git")], {
      env: gitEnv(),
      stdio: "pipe",
    });
    this.items.push(w);
    this.save();
    return w;
  }
  records(wid) {
    return read(path.join(this.root, this.get(wid).id, "rounds.json"), []);
  }
  saveRecords(wid, rounds) {
    privateJson(path.join(this.root, wid, "rounds.json"), rounds);
  }
  history(wid, sid) {
    return this.records(wid).filter((r) => !sid || r.sessionId === sid);
  }
  files(wid) {
    const w = this.get(wid),
      files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(w.path, dir), { withFileTypes: true })) {
        const relative = path.join(dir, entry.name),
          absolute = path.join(w.path, relative);
        if (
          excludedPath(relative) ||
          this.protectedRoots.some((p) => absolute === p || absolute.startsWith(p + path.sep)) ||
          entry.isSymbolicLink()
        )
          continue;
        if (entry.isDirectory()) walk(relative);
        else if (entry.isFile()) {
          files.push(relative);
          if (files.length > 10000)
            problem("WORKSPACE_LIMIT", "工作区文件超过 10000 个，请缩小目录或完善 .gitignore");
        }
      }
    };
    walk("");
    if (!files.length) return [];
    const ignored = spawnSync(
      "git",
      [
        "--git-dir=" + path.join(this.root, wid, "git"),
        "--work-tree=" + w.path,
        "check-ignore",
        "--no-index",
        "-z",
        "--stdin",
      ],
      { input: files.join("\0") + "\0", env: gitEnv(), maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
    );
    if (ignored.error || ![0, 1].includes(ignored.status))
      problem("GIT_ERROR", "无法读取 Git 忽略规则");
    const skip = new Set(ignored.stdout.toString().split("\0"));
    return files.filter((f) => !skip.has(f)).sort();
  }
  snapshot(wid, label, overrides = {}) {
    const w = this.get(wid),
      manifest = {};
    let total = 0;
    for (const file of this.files(wid)) {
      const absolute = safePath(w.path, file),
        stat = fs.statSync(absolute);
      total += stat.size;
      if (stat.size > 10 * 1024 * 1024 || total > 100 * 1024 * 1024)
        problem(
          "WORKSPACE_LIMIT",
          "检查点支持单文件 10 MB、总计 100 MB，请调整工作区或 .gitignore",
        );
      const bytes = fs.readFileSync(absolute);
      manifest[file] = {
        oid: this.git(w, ["hash-object", "-w", "--stdin"], bytes).toString().trim(),
        mode: stat.mode & 0o111 ? "100755" : "100644",
      };
    }
    for (const [file, entry] of Object.entries(overrides)) {
      if (entry) manifest[file] = entry;
      else delete manifest[file];
    }
    const tree = Object.create(null);
    for (const [file, v] of Object.entries(manifest)) {
      const parts = file.split(path.sep);
      let node = tree;
      for (const p of parts.slice(0, -1)) node = node[p] ??= Object.create(null);
      node[parts.at(-1)] = { ...v };
    }
    const build = (node) =>
      this.git(
        w,
        ["mktree", "-z"],
        Buffer.from(
          Object.entries(node)
            .map(([name, value]) =>
              value.oid
                ? `${value.mode} blob ${value.oid}\t${name}\0`
                : `040000 tree ${build(value)}\t${name}\0`,
            )
            .join(""),
        ),
      )
        .toString()
        .trim();
    const treeId = build(tree);
    const previous = spawnSync(
      "git",
      [
        "--git-dir=" + path.join(this.root, wid, "git"),
        "rev-parse",
        "--verify",
        "refs/heads/checkpoints",
      ],
      { env: gitEnv() },
    );
    const commit = this.git(w, [
      "commit-tree",
      treeId,
      ...(previous.status === 0 ? ["-p", previous.stdout.toString().trim()] : []),
      "-m",
      label,
    ])
      .toString()
      .trim();
    this.git(w, ["update-ref", "refs/heads/checkpoints", commit]);
    return { commit, manifest };
  }
  begin(wid, sid, label, tracked = false) {
    const w = this.get(wid);
    for (const [other, owner] of this.owners) {
      const p = this.get(other);
      if (
        owner !== sid &&
        (p.path === w.path ||
          p.path.startsWith(w.path + path.sep) ||
          w.path.startsWith(p.path + path.sep))
      )
        problem("WORKSPACE_BUSY", "工作区被另一段对话占用，请等待它结束");
    }
    const rounds = this.records(wid);
    if (rounds.some((r) => r.sessionId === sid && r.status === "running")) {
      this.owners.set(wid, sid);
      return;
    }
    this.owners.set(wid, sid);
    try {
      const before = this.snapshot(wid, "Before: " + label.slice(0, 100));
      rounds.push({
        id: id("round"),
        sessionId: sid,
        label: label.slice(0, 200),
        startedAt: now(),
        status: "running",
        before,
        tracked,
        expected: {},
        changes: [],
      });
      this.saveRecords(wid, rounds);
    } catch (e) {
      this.owners.delete(wid);
      throw e;
    }
  }
  assertExpected(wid, sid, file) {
    const round = this.records(wid).findLast((r) => r.sessionId === sid && r.status === "running");
    if (!round?.tracked || excludedPath(file)) return;
    const expected = Object.hasOwn(round.expected, file)
      ? round.expected[file]
      : round.before.manifest[file];
    const absolute = safePath(this.get(wid).path, file);
    const current = fs.existsSync(absolute)
      ? this.git(this.get(wid), ["hash-object", "--stdin"], fs.readFileSync(absolute))
          .toString()
          .trim()
      : undefined;
    if (current !== expected?.oid)
      problem("EDIT_CONFLICT", "文件在本轮执行中被外部修改，请停止后重新发起任务；未覆盖用户内容");
  }
  recordChange(wid, sid, file) {
    if (excludedPath(file)) return;
    const rounds = this.records(wid),
      round = rounds.findLast((r) => r.sessionId === sid && r.status === "running");
    if (!round?.tracked) return;
    const w = this.get(wid),
      absolute = safePath(w.path, file),
      stat = fs.statSync(absolute, { throwIfNoEntry: false });
    round.expected[file] = stat
      ? {
          oid: this.git(w, ["hash-object", "-w", "--stdin"], fs.readFileSync(absolute))
            .toString()
            .trim(),
          mode: stat.mode & 0o111 ? "100755" : "100644",
        }
      : null;
    this.saveRecords(wid, rounds);
  }
  finish(wid, sid, status = "finished") {
    const rounds = this.records(wid),
      round = rounds.findLast((r) => r.sessionId === sid && r.status === "running");
    if (!round) {
      if (this.owners.get(wid) === sid) this.owners.delete(wid);
      return;
    }
    const after = this.snapshot(wid, "After: " + round.label, round.tracked ? round.expected : {});
    round.after = after;
    round.status = status;
    round.finishedAt = now();
    round.changes = this.diff(round.before.manifest, after.manifest).filter(
      (c) => !round.tracked || Object.hasOwn(round.expected, c.path),
    );
    this.saveRecords(wid, rounds);
    if (this.owners.get(wid) === sid) this.owners.delete(wid);
  }
  diff(before, after) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((f) => before[f]?.oid !== after[f]?.oid || before[f]?.mode !== after[f]?.mode)
      .map((file) => ({
        path: file,
        kind: !before[file] ? "added" : !after[file] ? "deleted" : "modified",
      }));
  }
  detail(wid, sid, rid) {
    const r =
      this.history(wid, sid).find((r) => r.id === rid) ?? problem("NOT_FOUND", "修改记录不存在");
    return {
      ...r,
      files: r.changes.map((c) => ({
        ...c,
        before: this.content(wid, r.before.manifest[c.path]),
        after: this.content(wid, r.after?.manifest[c.path]),
      })),
    };
  }
  content(wid, entry) {
    if (!entry) return "";
    const b = this.git(this.get(wid), ["cat-file", "blob", entry.oid]);
    return b.includes(0) ? "[二进制文件]" : b.toString().slice(0, 30000);
  }
  rollback(wid, sid, rid) {
    if (this.owners.has(wid)) problem("WORKSPACE_BUSY", "请先停止工作区内正在执行的任务");
    const rounds = this.records(wid),
      round = rounds.find((r) => r.id === rid && r.sessionId === sid);
    if (!round?.after || round.revertedAt) problem("INVALID_ARGUMENT", "记录不可撤销");
    const w = this.get(wid),
      conflicts = [];
    for (const c of round.changes) {
      const file = safePath(w.path, c.path);
      const expected = round.after.manifest[c.path];
      const exists = fs.lstatSync(file, { throwIfNoEntry: false });
      if (exists?.isSymbolicLink() || (exists && !exists.isFile())) {
        conflicts.push(c.path);
        continue;
      }
      const oid = exists
        ? this.git(w, ["hash-object", "--stdin"], fs.readFileSync(file)).toString().trim()
        : undefined;
      if (
        oid !== expected?.oid ||
        (exists && (exists.mode & 0o111 ? "100755" : "100644") !== expected.mode)
      )
        conflicts.push(c.path);
    }
    if (conflicts.length)
      problem("ROLLBACK_CONFLICT", "文件已有后续修改，撤销冲突；没有覆盖文件", { conflicts });
    const backup = this.snapshot(wid, "Before rollback " + rid);
    privateJson(path.join(this.root, wid, "rollback-pending.json"), { roundId: rid, backup });
    for (const c of round.changes) {
      const file = safePath(w.path, c.path),
        original = round.before.manifest[c.path];
      if (!original) fs.rmSync(file);
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, this.git(w, ["cat-file", "blob", original.oid]), {
          mode: original.mode === "100755" ? 0o755 : 0o644,
        });
        fs.chmodSync(file, original.mode === "100755" ? 0o755 : 0o644);
      }
    }
    const restored = this.snapshot(wid, "Rollback " + rid);
    round.revertedAt = now();
    round.rollbackCommit = restored.commit;
    this.saveRecords(wid, rounds);
    fs.rmSync(path.join(this.root, wid, "rollback-pending.json"));
    return { roundId: rid, commit: restored.commit, changes: round.changes };
  }
}
