import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../server/harness.mjs";
import { delay } from "../server/core.mjs";
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-runtime-"));
  const dir = path.join(root, "user");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "note.txt"), "original");
  const h = new Harness({ root: path.join(root, "state"), speed: 0 });
  t.after(async () => {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const w = h.workspaces.add(dir);
  const s = h.get(h.create({ workspaceId: w.id, autoStart: false, prompt: "修改资料" }).id);
  const a = s.agents.main;
  const invoke = (name, args = {}) => h.invoke(s, a, name, args);
  return { h, w, s, a, dir, invoke };
}
async function load(invoke, name) {
  await invoke("tool_load", { name });
}
test("real workspace edits create rollback history and invalidate old completion", async (t) => {
  const { h, w, s, dir, invoke } = setup(t);
  await load(invoke, "file_edit");
  await invoke("file_edit", { path: "note.txt", oldText: "original", newText: "changed" });
  assert.equal(s.approvals.length, 0);
  h.finishWorkspace(s);
  const round = h.workspaces.history(w.id, s.id)[0];
  assert.equal(round.changes.length, 1);
  h.rollbackWorkspace(s.id, round.id);
  assert.equal(fs.readFileSync(path.join(dir, "note.txt"), "utf8"), "original");
  assert.equal(s.agents.main.completion, undefined);
  assert.equal(s.status, "idle");
});
test("single-use delete approval becomes stale when permission changes", async (t) => {
  const { h, s, dir, invoke } = setup(t);
  await load(invoke, "file_delete");
  const pending = invoke("file_delete", { path: "note.txt" });
  const rejected = assert.rejects(pending, /撤销|改变/);
  await delay(5);
  const approval = s.approvals.at(-1);
  assert.equal(approval.scope, "once");
  h.permissions.set(s, "full");
  await rejected;
  assert.throws(() => h.approve(s.id, approval.id, "once"), /失效/);
  assert.equal(fs.readFileSync(path.join(dir, "note.txt"), "utf8"), "original");
});
test("auto-review failure falls back to explicit approval, never silent permission", async (t) => {
  const { h, s, dir, invoke } = setup(t);
  h.permissions.set(s, "review");
  await load(invoke, "file_delete");
  const pending = invoke("file_delete", { path: "note.txt" });
  await delay(5);
  assert.equal(s.approvals.at(-1).status, "pending");
  h.approve(s.id, s.approvals.at(-1).id, "once");
  await pending;
  assert(!fs.existsSync(path.join(dir, "note.txt")));
});
test("private storage and credential files are denied even through aliases", async (t) => {
  const { h, s, dir, invoke } = setup(t);
  await load(invoke, "file_read");
  h.permissions.set(s, "full");
  fs.writeFileSync(path.join(dir, ".env"), "private");
  fs.symlinkSync(h.store.root, path.join(dir, "alias"));
  await assert.rejects(invoke("file_read", { path: ".env" }), /凭据/);
  await assert.rejects(invoke("file_read", { path: "alias/settings/models.json" }), /凭据/);
});
test("pet slow reaction records waiting context and groups immediate repeats", async (t) => {
  const { h, s } = setup(t);
  const args = { kind: "slow", target: { type: "task", id: s.id }, reason: "太慢了" };
  h.companion.feedback(s.id, args);
  h.companion.feedback(s.id, args);
  const data = h.companion.export(s.id);
  assert.equal(data.feedback.length, 1);
  assert.equal(data.feedback[0].count, 2);
  assert.equal(s.status, "idle");
});
test("workspace listing excludes application state even when its parent is selected", async (t) => {
  const { h, dir } = setup(t);
  const parent = h.workspaces.add(path.dirname(dir));
  const files = h.workspaces.files(parent.id);
  assert(files.includes("user/note.txt"));
  assert(!files.some((f) => f.startsWith("state/")));
});
test("manual edits during a turn are not attributed to the model or overwritten", async (t) => {
  const { h, w, s, dir, invoke } = setup(t);
  h.beginWorkspace(s);
  await load(invoke, "file_edit");
  fs.writeFileSync(path.join(dir, "note.txt"), "user changed");
  await assert.rejects(
    invoke("file_edit", { path: "note.txt", oldText: "user changed", newText: "model" }),
    /外部修改/,
  );
  fs.writeFileSync(path.join(dir, "note.txt"), "original");
  await invoke("file_edit", { path: "note.txt", oldText: "original", newText: "model" });
  fs.writeFileSync(path.join(dir, "manual.txt"), "human only");
  fs.writeFileSync(path.join(dir, "note.txt"), "human newer");
  h.finishWorkspace(s);
  const r = h.workspaces.history(w.id, s.id)[0];
  assert.deepEqual(
    r.changes.map((c) => c.path),
    ["note.txt"],
  );
  assert.equal(h.workspaces.content(w.id, r.after.manifest["note.txt"]), "model");
  assert.throws(() => h.rollbackWorkspace(s.id, r.id), /冲突/);
  assert.equal(fs.readFileSync(path.join(dir, "note.txt"), "utf8"), "human newer");
});
