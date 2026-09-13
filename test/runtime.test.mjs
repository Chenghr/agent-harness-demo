import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../server/harness.mjs";
import { delay, deferred, Semaphore } from "../server/core.mjs";
import { BROKEN_CART, FIXED_CART } from "../server/fixtures.mjs";

async function waitFor(check, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for condition");
    await delay(10);
  }
}
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-runtime-"));
  const h = new Harness({ root, speed: 0, ...options });
  t.after(async () => {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return h;
}
function idle(h, extra = {}) {
  const snap = h.create({ autoStart: false, ...extra });
  const s = h.get(snap.id);
  return { s, a: s.agents.main };
}
function approveAll(h) {
  h.on("event", (e) => {
    if (e.type === "approval.requested")
      queueMicrotask(() => h.approve(e.sessionId, e.data.id, "once"));
  });
}

test(
  "complete scenario uses real failing tests, approval, fix, passing tests and cleanup",
  { timeout: 15000 },
  async (t) => {
    const h = setup(t, { modelConcurrency: 1 });
    approveAll(h);
    const snap = h.create({ scenario: "full" });
    const s = h.get(snap.id);
    await waitFor(() => ["completed", "failed"].includes(s.status));
    assert.equal(s.status, "completed");
    assert.equal(s.stats.failed, 0);
    assert.equal(fs.readFileSync(path.join(s.workspace, "cart.mjs"), "utf8"), FIXED_CART);
    assert.equal(
      s.actions.filter((a) => a.tool === "run_tests" && a.agentId === "main").at(-1).result
        .exitCode,
      0,
    );
    assert.ok(s.actions.some((a) => a.tool === "run_tests" && a.result.exitCode === 1));
    assert.ok(s.agents.main.compactions >= 1);
    assert.equal(h.processes.list().length, 0);
    assert.ok(Object.values(s.agents).every((a) => ["completed", "needs_review"].includes(a.status)));
    assert.equal(s.agents.main.completion.report.verdict, "pass");
  },
);
test("context handoff demo waits for one visible manual compaction", async (t) => {
  const h = setup(t),
    snap = h.create({ scenario: "context", model: "demo-balanced" }),
    s = h.get(snap.id);
  await waitFor(() => ["completed", "needs_review", "failed"].includes(s.status));
  assert.notEqual(s.status, "failed");
  assert.equal(s.agents.main.compactions, 0);
  assert.equal(s.agents.main.summary, "");
  const before = h.context.build(s, s.agents.main, h.models.get("demo-balanced")).tokens;
  const result = await h.context.compact(s, s.agents.main, {
    force: true,
    allowClosing: true,
    delayMs: 0,
  });
  const after = h.context.build(s, s.agents.main, h.models.get("demo-balanced")).tokens;
  assert.equal(result.skipped, undefined);
  assert.equal(s.agents.main.compactions, 1);
  assert.ok(result.units > 0);
  assert.ok(after < before);
  assert.match(s.agents.main.summary, /artifact_read/);
});
test("capability demo starts empty and supports one targeted Skill load and unload", async (t) => {
  const h = setup(t),
    snap = h.create({ scenario: "capability", model: "demo-balanced" }),
    s = h.get(snap.id),
    a = s.agents.main;
  await waitFor(() => ["completed", "needs_review", "failed"].includes(s.status));
  assert.notEqual(s.status, "failed");
  assert.deepEqual(a.loadedSkills, []);
  const loaded = h.capabilityLoader.load(s, a, "skill", "commerce-volume-trend");
  assert.equal(loaded.loaded, true);
  assert.deepEqual(a.loadedSkills, ["commerce-volume-trend"]);
  const unloaded = h.unload(s, a, "skill", "commerce-volume-trend");
  assert.equal(unloaded.historyPreserved, true);
  assert.deepEqual(a.loadedSkills, []);
});
test("security demonstration loads untrusted skill but denies its requested actions", async (t) => {
  const h = setup(t),
    snap = h.create({ scenario: "security" }),
    s = h.get(snap.id);
  await waitFor(() => s.status === "completed");
  assert.ok(s.actions.some((a) => a.code === "PATH_DENIED"));
  assert.ok(s.actions.some((a) => a.code === "POLICY_DENIED"));
  assert.equal(s.approvals.length, 0);
  assert.equal(fs.readFileSync(path.join(s.workspace, "cart.mjs"), "utf8"), BROKEN_CART);
});
test("denied write never mutates the file and is visible in results", async (t) => {
  const h = setup(t),
    { s, a } = idle(h);
  await h.invoke(s, a, "tool_load", { name: "file_write" });
  const pending = h.invoke(s, a, "file_write", { path: "cart.mjs", content: FIXED_CART });
  await waitFor(() => s.approvals.length === 1);
  h.approve(s.id, s.approvals[0].id, "deny");
  await assert.rejects(pending, { code: "APPROVAL_DENIED" });
  assert.equal(fs.readFileSync(path.join(s.workspace, "cart.mjs"), "utf8"), BROKEN_CART);
});
test("task authorization is scoped to a file and can be revoked", async (t) => {
  const h = setup(t),
    { s, a } = idle(h);
  await h.invoke(s, a, "tool_load", { name: "file_write" });
  const write = h.invoke(s, a, "file_write", { path: "cart.mjs", content: FIXED_CART });
  await waitFor(() => s.approvals.length === 1);
  h.approve(s.id, s.approvals[0].id, "task");
  await write;
  await h.invoke(s, a, "file_write", { path: "cart.mjs", content: FIXED_CART });
  assert.equal(s.approvals.length, 1);
  h.revoke(s.id);
  assert.equal(s.grants.length, 0);
  const write2 = h.invoke(s, a, "file_write", { path: "other.txt", content: "new" });
  await waitFor(() => s.approvals.length === 2);
  h.approve(s.id, s.approvals[1].id, "deny");
  await assert.rejects(write2, { code: "APPROVAL_DENIED" });
});
test("late approval cannot revive an aborted operation", async (t) => {
  const h = setup(t),
    { s, a } = idle(h);
  await h.invoke(s, a, "tool_load", { name: "file_write" });
  const ctrl = new AbortController();
  const write = h.invoke(
    s,
    a,
    "file_write",
    { path: "cart.mjs", content: FIXED_CART },
    { signal: ctrl.signal },
  );
  await waitFor(() => s.approvals.length === 1);
  ctrl.abort();
  await assert.rejects(write, { code: "CANCELLED" });
  assert.throws(() => h.approve(s.id, s.approvals[0].id, "once"), { code: "STALE_APPROVAL" });
  assert.equal(fs.readFileSync(path.join(s.workspace, "cart.mjs"), "utf8"), BROKEN_CART);
});
test("revocation blocks an authorized write waiting for the workspace lock", async (t) => {
  const h = setup(t),
    { s, a } = idle(h);
  await h.invoke(s, a, "tool_load", { name: "file_write" });
  s.grants.push({ id: "g", tool: "file_write", path: "cart.mjs" });
  const lock = new Semaphore(1),
    gate = deferred();
  h.writeLocks.set(s.id, lock);
  const held = lock.run(() => gate.promise);
  const write = h.invoke(s, a, "file_write", { path: "cart.mjs", content: FIXED_CART });
  await waitFor(() => s.actions.some((x) => x.tool === "file_write" && x.status === "running"));
  h.revoke(s.id);
  gate.resolve();
  await held;
  await assert.rejects(write, { code: "APPROVAL_DENIED" });
  assert.equal(fs.readFileSync(path.join(s.workspace, "cart.mjs"), "utf8"), BROKEN_CART);
});
test("skills load declared references on demand and unload without erasing history", async (t) => {
  const h = setup(t),
    { s, a } = idle(h);
  await h.invoke(s, a, "skill_load", { name: "code-debug" });
  const ref = await h.invoke(s, a, "skill_read_resource", {
    name: "code-debug",
    path: "references/checklist.md",
  });
  assert.ok(ref.content.length > 10);
  await assert.rejects(
    h.invoke(s, a, "skill_read_resource", { name: "code-debug", path: "../../.env" }),
    { code: "PATH_DENIED" },
  );
  h.context.add(s, a, [{ role: "assistant", content: "Evidence retained after unloading" }]);
  const historyBefore = structuredClone(a.history);
  await h.invoke(s, a, "skill_unload", { name: "code-debug" });
  assert.equal(a.loadedSkills.length, 0);
  assert.equal(a.skillSnapshots["code-debug"], undefined);
  assert.deepEqual(a.history, historyBefore);
  await assert.rejects(
    h.invoke(s, a, "skill_read_resource", { name: "code-debug", path: "references/checklist.md" }),
    { code: "SKILL_NOT_LOADED" },
  );
  await h.invoke(s, a, "tool_load", { name: "run_tests" });
  await h.invoke(s, a, "tool_unload", { name: "run_tests" });
  await assert.rejects(h.invoke(s, a, "run_tests", {}), { code: "TOOL_NOT_LOADED" });
  await assert.rejects(h.invoke(s, a, "tool_unload", { name: "catalog_search" }));
});
test("late model response after steering cannot dispatch old tools", async (t) => {
  const gate = deferred();
  let calls = 0;
  const adapter = {
    async complete() {
      calls++;
      if (calls === 1) {
        await gate.promise;
        return {
          text: "old",
          calls: [
            {
              id: "old-call",
              type: "function",
              function: {
                name: "file_write",
                arguments: JSON.stringify({ path: "cart.mjs", content: "bad" }),
              },
            },
          ],
        };
      }
      return { text: "new direction", calls: [] };
    },
  };
  const h = setup(t, { modelAdapter: adapter }),
    snap = h.create(),
    s = h.get(snap.id);
  await waitFor(() => calls === 1);
  h.message(s.id, "先不要修改文件，只给分析", "steer");
  gate.resolve();
  await waitFor(() => s.status === "needs_review");
  assert.equal(s.actions.filter((a) => a.tool === "file_write").length, 0);
  assert.ok(h.store.events(s.id).some((e) => e.type === "model.stale"));
  assert.equal(s.readOnly, true);
});
test("successive steering uses only the latest user direction", async (t) => {
  const gate = deferred();
  let count = 0;
  const h = setup(t, {
    modelAdapter: {
      async complete() {
        if (++count === 1) await gate.promise;
        return { text: "done", calls: [] };
      },
    },
  });
  const snap = h.create(),
    s = h.get(snap.id);
  await waitFor(() => count === 1);
  h.message(s.id, "第一条修正", "steer");
  h.message(s.id, "第二条修正，只读", "steer");
  gate.resolve();
  await waitFor(() => s.status === "needs_review");
  assert.equal(s.agents.main.goal, "第二条修正，只读");
  assert.equal(s.readOnly, true);
  assert.equal(count, 2);
});
test(
  "stopping a parent cancels background processes and rejects new descendants",
  { timeout: 15000 },
  async (t) => {
    const h = setup(t, { speed: 0.03 }),
      snap = h.create({ scenario: "interrupt" }),
      s = h.get(snap.id);
    await waitFor(() => h.processes.list(s.id).length > 0);
    await h.stop(s.id);
    assert.equal(s.status, "cancelled");
    assert.equal(h.processes.list(s.id).length, 0);
    assert.throws(() => h.spawnAgent(s, s.agents.main, "late child"), { code: "CLOSING" });
    assert.ok(Object.values(s.agents).every((a) => ["cancelled", "completed", "needs_review"].includes(a.status)));
  },
);
test("subagent writes are denied even when parent has a matching grant", async (t) => {
  const h = setup(t),
    { s, a } = idle(h);
  const child = h.agent(s, { agentId: "child", parentId: a.id, goal: "analyze", model: a.model });
  child.loadedTools.push("file_write");
  s.grants.push({ id: "g", tool: "file_write", path: "cart.mjs" });
  await assert.rejects(h.invoke(s, child, "file_write", { path: "cart.mjs", content: "bad" }), {
    code: "POLICY_DENIED",
  });
});
test("compaction discards stale summary if user requirements change", async (t) => {
  const h = setup(t),
    { s, a } = idle(h);
  for (let i = 0; i < 8; i++)
    h.context.add(s, a, [{ role: "assistant", content: "old fact " + i }]);
  const before = a.history.length;
  const compact = h.context.compact(s, a, { delayMs: 60 });
  s.revision++;
  s.userRequirements.push("new requirement");
  const result = await compact;
  assert.equal(result.discarded, true);
  assert.equal(a.history.length, before);
  assert.equal(a.summary, "");
});
test("compaction retains incomplete tool units and external original history", async (t) => {
  const h = setup(t),
    { s, a } = idle(h, { prompt: "不要修改测试文件" });
  const pending = h.context.add(
    s,
    a,
    [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "pending", type: "function", function: { name: "file_read", arguments: "{}" } },
        ],
      },
    ],
    false,
  );
  for (let i = 0; i < 8; i++)
    h.context.add(s, a, [{ role: "assistant", content: "diagnostic " + i + " ".repeat(400) }]);
  const result = await h.context.compact(s, a, { delayMs: 0 });
  assert.ok(!result.skipped);
  assert.ok(a.history.some((u) => u.id === pending.id));
  assert.ok(h.context.system(s, a).includes("不要修改测试文件"));
  assert.ok(
    h.store
      .events(s.id)
      .some((e) => e.type === "context.unit" && JSON.stringify(e).includes("diagnostic 0")),
  );
});
test("model handoff preserves grants, skills and facts while leaving child model pinned", async (t) => {
  const h = setup(t),
    { s, a } = idle(h);
  await h.invoke(s, a, "skill_load", { name: "code-debug" });
  await h.invoke(s, a, "tool_load", { name: "file_write" });
  s.grants.push({ id: "g", tool: "file_write", path: "cart.mjs" });
  const child = h.agent(s, { agentId: "child", parentId: a.id, goal: "inspect", model: a.model });
  child.status = "completed";
  child.result = "evidence";
  await h.requestSwitch(s.id, "demo-focused");
  assert.equal(a.model, "demo-focused");
  assert.equal(child.model, "demo-balanced");
  assert.equal(s.grants.length, 1);
  assert.deepEqual(a.loadedSkills, ["code-debug"]);
  assert.equal(s.handoffs.length, 1);
  assert.ok(a.history[0].messages[0].content.includes("已完成操作不得重复执行"));
});
test("failed handoff does not replace original context or model", async (t) => {
  const h = setup(t),
    { s, a } = idle(h);
  const oldHistory = a.history;
  h.models.profiles.find((p) => p.id === "demo-focused").contextWindow = 2100;
  await assert.rejects(h.requestSwitch(s.id, "demo-focused"), { code: "CONTEXT_LIMIT" });
  assert.equal(a.model, "demo-balanced");
  assert.equal(a.history, oldHistory);
  assert.equal(s.handoffs.length, 0);
});
test("unconfigured real model is rejected, never silently simulated", (t) => {
  const h = setup(t, { env: {} });
  assert.throws(() => h.create({ model: "api-primary" }), { code: "MODEL_UNCONFIGURED" });
});
test("model switch invalidates a compaction started against the old context", async (t) => {
  const h = setup(t),
    { s, a } = idle(h);
  for (let i = 0; i < 8; i++) h.context.add(s, a, [{ role: "assistant", content: "old " + i }]);
  const compaction = h.context.compact(s, a, { delayMs: 60 });
  await h.requestSwitch(s.id, "demo-focused");
  const handoffHistory = a.history;
  assert.equal((await compaction).discarded, true);
  assert.equal(a.history, handoffHistory);
  assert.equal(a.model, "demo-focused");
});
test("switch during a tool waits for its result and never replays that invocation", async (t) => {
  let count = 0;
  const observed = [];
  const h = setup(t, {
    modelAdapter: {
      async complete({ profile }) {
        observed.push(profile.id);
        return ++count === 1
          ? {
              text: "diagnose",
              calls: [
                {
                  id: "diagnostic-once",
                  type: "function",
                  function: { name: "run_diagnostic", arguments: '{"duration":150}' },
                },
              ],
            }
          : { text: "finished", calls: [] };
      },
    },
  });
  const { s, a } = idle(h, { scenario: "custom" });
  a.loadedTools.push("run_diagnostic");
  h.launch(s, a);
  await waitFor(() => h.processes.list(s.id).length === 1);
  await h.requestSwitch(s.id, "demo-focused");
  assert.equal(a.model, "demo-balanced");
  await waitFor(() => s.status === "needs_review");
  assert.deepEqual(observed, ["demo-balanced", "demo-focused"]);
  assert.equal(s.actions.filter((x) => x.tool === "run_diagnostic").length, 1);
  const events = h.store.events(s.id);
  assert.ok(
    events.find((e) => e.type === "tool.succeeded").seq <
      events.find((e) => e.type === "model.switched").seq,
  );
});
test("tool call budget stops a loop rather than producing unlimited repeated errors", async (t) => {
  const h = setup(t, { maxCalls: 2 }),
    snap = h.create({ scenario: "full" }),
    s = h.get(snap.id);
  await waitFor(() => s.status === "failed");
  assert.equal(s.stats.toolCalls, 3);
  assert.equal(h.processes.list().length, 0);
});
test(
  "1005 fixture calls run through real dispatch and compaction with bounded live history",
  { timeout: 30000 },
  async (t) => {
    const h = setup(t),
      snap = h.create({ scenario: "scale" }),
      s = h.get(snap.id);
    await waitFor(() => ["completed", "failed"].includes(s.status), 25000);
    assert.equal(s.status, "completed");
    assert.equal(s.stats.fixtureCalls, 1005);
    assert.equal(s.stats.failed, 0);
    assert.ok(s.agents.main.compactions > 0);
    assert.ok(s.actions.length <= 200);
    assert.equal(h.processes.list().length, 0);
    assert.equal(
      h.store
        .events(s.id, 0, Infinity)
        .filter(
          (e) =>
            e.type === "tool.succeeded" && e.data.result?.simulated === true && e.data.result?.tool,
        ).length,
      1005,
    );
  },
);
