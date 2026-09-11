import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../server/harness.mjs";
import { delay, deferred } from "../server/core.mjs";
import { FIXED_CART } from "../server/fixtures.mjs";

function setup(t, options = {}, unblock = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-completion-"));
  const h = new Harness({ root, speed: 0, env: {}, ...options });
  t.after(async () => { unblock(); await h.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return h;
}
async function drained(h) {
  const deadline = Date.now() + 6000;
  while (h.controls.size) {
    if (Date.now() > deadline) throw new Error("completion timed out");
    await delay(5);
  }
}
const answer = { async complete() { return { text: "工作已完成", calls: [] }; } };

test("a model claiming completion with broken output fails actual tests and cannot finish", async (t) => {
  const h = setup(t, { modelAdapter: answer });
  const s = h.get(h.create({ scenario: "full" }).id);
  await drained(h);
  assert.equal(s.status, "needs_review");
  assert.equal(s.agents.main.completion.attempt, 3);
  assert.ok(s.agents.main.completion.report.checks.some((c) => c.status === "failed"));
  assert.ok(!h.store.events(s.id).some((e) => e.type === "session.completed"));
  assert.equal(h.processes.list().length, 0);
});

test("failed result checks reach the model and a real repair passes fresh verification", async (t) => {
  let requests = 0, sawFeedback = false;
  const h = setup(t, { modelAdapter: {
    async complete({ input }) {
      requests++;
      if (requests === 2) {
        sawFeedback = JSON.stringify(input.messages).includes("成果检查未通过");
        return { calls: [{ id: "repair", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "cart.mjs", content: FIXED_CART }) } }] };
      }
      return { text: "修复完成", calls: [] };
    },
  } });
  h.on("event", (e) => { if (e.type === "approval.requested") queueMicrotask(() => h.approve(e.sessionId, e.data.id, "once")); });
  const s = h.get(h.create({ autoStart: false }).id);
  s.agents.main.loadedTools.push("file_write");
  h.launch(s, s.agents.main);
  await drained(h);
  assert.ok(sawFeedback);
  assert.equal(requests, 3);
  assert.equal(s.status, "completed");
  assert.equal(s.agents.main.completion.acceptedBy, "checks");
  assert.equal(s.agents.main.completion.report.verdict, "pass");
});

test("custom work requires explicit acceptance and acceptance grants no tool permission", async (t) => {
  const h = setup(t, { modelAdapter: answer });
  const s = h.get(h.create({ scenario: "custom", prompt: "分析这些材料" }).id);
  await drained(h);
  assert.equal(s.status, "needs_review");
  const id = s.agents.main.completion.id;
  h.reviewCompletion(s.id, { reviewId: id, decision: "accept" });
  assert.equal(s.status, "completed");
  assert.equal(s.agents.main.completion.acceptedBy, "user");
  assert.equal(s.grants.length, 0);
  assert.throws(() => h.reviewCompletion(s.id, { reviewId: id, decision: "accept" }), { code: "STALE_REVIEW" });
});

test("acceptance of an old result is rejected after files change", async (t) => {
  const h = setup(t, { modelAdapter: answer });
  const s = h.get(h.create({ scenario: "custom" }).id);
  await drained(h);
  const id = s.agents.main.completion?.id;
  fs.writeFileSync(path.join(s.workspace, "cart.mjs"), FIXED_CART);
  assert.throws(() => h.reviewCompletion(s.id, { reviewId: id, decision: "accept" }), { code: "STALE_REVIEW" });
  assert.equal(s.status, "needs_review");
});

test("requesting changes restarts work with feedback and invalidates the old acceptance", async (t) => {
  const inputs = [];
  const h = setup(t, { modelAdapter: { async complete({ input }) { inputs.push(JSON.stringify(input.messages)); return { text: "answer", calls: [] }; } } });
  const s = h.get(h.create({ scenario: "custom" }).id);
  await drained(h);
  const id = s.agents.main.completion?.id;
  h.reviewCompletion(s.id, { reviewId: id, decision: "revise", feedback: "请补充引用来源" });
  await drained(h);
  assert.equal(inputs.length, 2);
  assert.ok(inputs[1].includes("请补充引用来源"));
  assert.equal(s.status, "needs_review");
  assert.notEqual(s.agents.main.completion.id, id);
});

test("a new user requirement during a check invalidates its passing result", async (t) => {
  const entered = deferred(), release = deferred();
  let checks = 0, requests = 0;
  const h = setup(t, {
    modelAdapter: { async complete() { requests++; return { text: "answer", calls: [] }; } },
    async completionCheck() {
      if (++checks === 1) { entered.resolve(); await release.promise; }
      return { verdict: "pass", summary: "测试专用规则通过", checks: [{ name: "test", status: "passed", detail: "已检查" }] };
    },
  }, () => release.resolve());
  const s = h.get(h.create({ scenario: "custom" }).id);
  await Promise.race([entered.promise, h.controller(s, s.agents.main).completion]);
  h.message(s.id, "加入新的检查要求", "append");
  release.resolve();
  await drained(h);
  assert.equal(checks, 2);
  assert.equal(requests, 2);
  assert.equal(s.status, "completed");
});

test("changing the protected test cannot lower the configured acceptance standard", async (t) => {
  const h = setup(t, { modelAdapter: answer });
  const s = h.get(h.create({ autoStart: false }).id);
  fs.writeFileSync(path.join(s.workspace, "cart.test.mjs"), "// all checks removed");
  h.launch(s, s.agents.main);
  await drained(h);
  assert.equal(s.status, "needs_review");
  assert.ok(s.agents.main.completion.report.checks.some((c) => c.name === "原有测试未改动" && c.status === "failed"));
  assert.throws(() => h.reviewCompletion(s.id, { reviewId: s.agents.main.completion.id, decision: "accept" }), { code: "CHECKS_FAILED" });
});

test("a pending review cannot revive a stopped task", async (t) => {
  const h = setup(t, { modelAdapter: answer });
  const s = h.get(h.create({ scenario: "custom" }).id);
  await drained(h);
  const reviewId = s.agents.main.completion.id;
  await h.stop(s.id);
  assert.throws(() => h.reviewCompletion(s.id, { reviewId, decision: "accept" }), { code: "STALE_REVIEW" });
  assert.equal(s.status, "cancelled");
});

test("zero exit without running the configured tests is not successful verification", async (t) => {
  const h = setup(t, { modelAdapter: answer });
  const s = h.get(h.create({ autoStart: false }).id);
  fs.writeFileSync(path.join(s.workspace, "cart.mjs"), "export const total = () => 0; process.exit(0);");
  h.launch(s, s.agents.main);
  await drained(h);
  assert.equal(s.status, "needs_review");
});
