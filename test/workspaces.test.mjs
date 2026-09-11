import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WorkspaceManager } from "../server/workspaces.mjs";
test("workspace checkpoints preserve dirty user git and refuse conflicting rollback", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "project");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "user draft");
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=local");
  execFileSync("git", ["init", "-q", dir]);
  const w = new WorkspaceManager(path.join(root, "state"));
  const p = w.add(dir);
  w.begin(p.id, "session", "first");
  assert.throws(() => w.begin(p.id, "another", "busy"), /占用/);
  fs.writeFileSync(path.join(dir, "a.txt"), "model output");
  fs.writeFileSync(path.join(dir, "new.txt"), "new");
  w.finish(p.id, "session");
  assert.equal(w.history(p.id, "session")[0].changes.length, 2);
  assert(!w.history(p.id, "session")[0].changes.some((x) => x.path === ".env"));
  const round = w.history(p.id, "session")[0];
  fs.writeFileSync(path.join(dir, "a.txt"), "user newer");
  assert.throws(() => w.rollback(p.id, "session", round.id), /冲突/);
  assert(fs.existsSync(path.join(dir, "new.txt")));
  fs.writeFileSync(path.join(dir, "a.txt"), "model output");
  w.rollback(p.id, "session", round.id);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "user draft");
  assert(!fs.existsSync(path.join(dir, "new.txt")));
  assert.equal(
    execFileSync("git", ["-C", dir, "status", "--porcelain"]).toString().includes("?? a.txt"),
    true,
  );
  const reopened = new WorkspaceManager(path.join(root, "state"));
  assert.equal(reopened.history(p.id, "session").length, 1);
  assert(reopened.history(p.id, "session")[0].revertedAt);
});
