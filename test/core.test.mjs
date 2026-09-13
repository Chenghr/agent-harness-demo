import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Semaphore, delay, safePath, ProcessManager, Store, validate } from "../server/core.mjs";
import { Catalog } from "../server/catalog.mjs";

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("queued semaphore cancellation releases no extra slot", async () => {
  const sem = new Semaphore(1),
    release = await sem.acquire();
  const ctrl = new AbortController();
  const waiting = sem.acquire(ctrl.signal);
  ctrl.abort();
  await assert.rejects(waiting, { code: "CANCELLED" });
  assert.equal(sem.active, 1);
  assert.equal(sem.queue.length, 0);
  release();
  assert.equal(sem.active, 0);
  const release2 = await sem.acquire();
  release2();
  assert.equal(sem.active, 0);
});
test("workspace path handling accepts canonical temp roots and rejects traversal and symlinks", (t) => {
  const root = directory(t),
    inside = path.join(root, "work");
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, "safe.txt"), "safe");
  assert.equal(fs.readFileSync(safePath(inside, "safe.txt"), "utf8"), "safe");
  assert.throws(() => safePath(inside, "../secret"), { code: "PATH_DENIED" });
  assert.throws(() => safePath(inside, "/etc/passwd"), { code: "PATH_DENIED" });
  fs.symlinkSync(root, path.join(inside, "escape"));
  assert.throws(() => safePath(inside, "escape/outside.txt"), { code: "PATH_DENIED" });
});
test("parameter validation rejects unknown, malformed and nonfinite values", () => {
  const schema = {
    type: "object",
    properties: { n: { type: "number", minimum: 1, maximum: 4 } },
    required: ["n"],
    additionalProperties: false,
  };
  validate(schema, { n: 3 });
  for (const value of [{ n: 0 }, { n: NaN }, { n: "3" }, {}, { n: 1, extra: true }, []])
    assert.throws(() => validate(schema, value), { code: "INVALID_ARGUMENT" });
});
test("catalog supports 1000+ independently named tools and loadable skill files", (t) => {
  const catalog = new Catalog(directory(t));
  assert.equal(catalog.counts().fixtureTools, 1200);
  assert.equal(catalog.counts().generatedSkills, 1200);
  assert.equal(
    catalog.search("analytics__latency__mean", "tool").items[0].name,
    "analytics__latency__mean",
  );
  assert.equal(catalog.search("no-such-capability-zzzz", "all").total, 0);
  assert.equal(catalog.compute("analytics__latency__mean", { values: [2, 4, 6] }).value, 4);
  assert.equal(catalog.compute("commerce__volume__trend", { values: [8, 5, 9] }).value, 1);
  assert.throws(() => catalog.compute("commerce__volume__mean", { values: [] }), {
    code: "INVALID_ARGUMENT",
  });
  for (const name of catalog.skills.keys()) {
    const skill = catalog.getSkill(name);
    assert.ok(skill.content.includes("name: " + name));
  }
  assert.ok(catalog.search("测试", "skill").items.length > 0);
  const teacher = catalog.getSkill("teacher-day-orchestrator");
  assert.equal(teacher.category, "教师节数字展馆");
  assert.ok(teacher.resources.includes("references/workflow.md"));
  assert.match(teacher.content, /每位成员使用一个独立图片助手/);
  for (const name of [
    "blessing-copy-editor",
    "portrait-art-director",
    "greeting-site-builder",
    "delivery-qa-reviewer",
    "mentor-music-director",
    "mentor-video-storyboard",
  ])
    assert.ok(catalog.getSkill(name).content.includes(`name: ${name}`));
});
test("event sequence continues beyond 2000 records after reopening store", (t) => {
  const root = directory(t);
  const a = new Store(root);
  a.save({ id: "task_test" });
  for (let i = 0; i < 2100; i++) a.event("task_test", "probe", { i });
  const b = new Store(root);
  b.loadAll();
  assert.equal(b.event("task_test", "continued").seq, 2101);
  assert.equal(b.events("task_test", 2099).length, 2);
});
test(
  "process cancellation drains output and reaps process group",
  { timeout: 10000 },
  async (t) => {
    const root = directory(t),
      events = [];
    const manager = new ProcessManager((type, data) => events.push({ type, data }));
    const ctrl = new AbortController();
    const task = manager.run({
      sessionId: "s",
      agentId: "main",
      cwd: root,
      args: ["-e", "console.log('ready');setInterval(()=>console.log('tick'),30)"],
      signal: ctrl.signal,
    });
    while (!events.some((e) => e.type === "process.output")) await delay(10);
    const pid = manager.list()[0].pid;
    ctrl.abort();
    await assert.rejects(task, { code: "CANCELLED" });
    assert.equal(manager.list().length, 0);
    assert.ok(events.some((e) => e.type === "process.exited"));
    assert.throws(() => process.kill(pid, 0));
  },
);
test(
  "leader exit reaps descendants even while they hold output pipes",
  { timeout: 10000 },
  async (t) => {
    if (process.platform === "win32") return t.skip("POSIX process-group verification");
    const root = directory(t),
      manager = new ProcessManager(() => {}),
      ctrl = new AbortController();
    const program =
      "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>console.log(\"child\"),30)'],{stdio:['ignore',process.stdout,process.stderr]});setTimeout(()=>process.exit(0),50);";
    const task = manager.run({
      sessionId: "s",
      agentId: "a",
      cwd: root,
      args: ["-e", program],
      signal: ctrl.signal,
      timeout: 3000,
    });
    const result = await task;
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanup, "released");
    assert.throws(() => process.kill(-result.pid, 0));
    assert.equal(manager.list().length, 0);
  },
);
test(
  "process timeout reports confirmed cleanup, not successful execution",
  { timeout: 10000 },
  async (t) => {
    const manager = new ProcessManager(() => {});
    await assert.rejects(
      manager.run({
        sessionId: "s",
        agentId: "a",
        cwd: directory(t),
        args: ["-e", "setInterval(()=>{},1000)"],
        timeout: 100,
      }),
      { code: "TIMEOUT" },
    );
    assert.equal(manager.list().length, 0);
  },
);
