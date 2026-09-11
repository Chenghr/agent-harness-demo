import test from "node:test";
import assert from "node:assert/strict";
import { TaskController } from "../server/runtime/task-controller.ts";
import type { CompletionReport, ControllerPorts, ControlState, InboxMessage, RunOutcome } from "../server/runtime/contracts.ts";

const pass = (): CompletionReport => ({ verdict: "pass", summary: "规则检查通过", checks: [{ name: "output", status: "passed", detail: "已验证" }] });
const revise = (): CompletionReport => ({ verdict: "revise", summary: "缺少输出文件，请生成后再提交", checks: [{ name: "output", status: "failed", detail: "文件不存在" }] });
const manual = (): CompletionReport => ({ verdict: "review", summary: "需要用户检查文字质量", checks: [{ name: "quality", status: "unknown", detail: "没有自动检查规则" }] });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(overrides: Partial<ControllerPorts> = {}) {
  const state: ControlState = { epoch: 0, status: "idle", result: null, pendingModel: null, pendingMessages: [] };
  const inputs: InboxMessage[] = [], outcomes: RunOutcome[] = [], events: string[] = [];
  let id = 0, decisions = 0;
  const ports: ControllerPorts = {
    isScopeOpen: () => true,
    admitInput: (messages) => { inputs.push(...messages); },
    step: async () => ({ kind: "candidate", text: `answer-${++decisions}` }),
    hasPendingWork: () => false,
    waitForWork: async () => {}, cancelDescendants: async () => {}, advanced: () => {},
    statusChanged: () => {}, settled: (outcome) => { outcomes.push(outcome); }, released: () => {},
    event: (type) => { events.push(type); }, messageId: () => String(++id),
    completionVersion: () => "version-1", verifyCompletion: async () => pass(),
    ...overrides,
  };
  return { state, inputs, outcomes, events, controller: new TaskController(state, ports), decisions: () => decisions };
}

test("failed checks return specific feedback to the model before a later pass can complete", async () => {
  let checks = 0;
  const f = setup({ verifyCompletion: async () => ++checks === 1 ? revise() : pass() });
  await f.controller.start();
  assert.equal(checks, 2);
  assert.equal(f.decisions(), 2);
  assert.ok(f.inputs.some((m) => m.source === "runtime" && m.content.includes("文件不存在")));
  assert.equal(f.outcomes.length, 1);
  assert.equal(f.state.status, "completed");
  assert.equal(f.state.completion?.report.verdict, "pass");
});

test("unverifiable work stops at needs_review without claiming completion", async () => {
  const f = setup({ verifyCompletion: async () => manual() });
  await f.controller.start();
  assert.equal(f.state.status, "needs_review");
  assert.equal(f.controller.running, false);
  assert.equal(f.outcomes[0]?.kind, "needs_review");
  assert.equal(f.state.result, "answer-1");
});

test("repeated check failure has a finite repair budget and cannot be accepted as passed", async () => {
  const f = setup({ verifyCompletion: async () => revise() });
  await f.controller.start();
  assert.equal(f.decisions(), 3);
  assert.equal(f.state.status, "needs_review");
  assert.throws(() => f.controller.acceptReview(f.state.completion!.id), { code: "CHECKS_FAILED" });
});

test("an input arriving during verification invalidates the old verdict", async () => {
  const entered = gate(), release = gate();
  let checks = 0;
  const f = setup({ async verifyCompletion() {
    if (++checks === 1) { entered.resolve(); await release.promise; }
    return pass();
  } });
  const running = f.controller.start();
  // On the old implementation verification is never entered; settle instead of hanging.
  await Promise.race([entered.promise, running]);
  f.controller.enqueue("new requirement", "user");
  release.resolve();
  await running;
  assert.equal(checks, 2);
  assert.equal(f.state.result, "answer-2");
  assert.ok(f.events.includes("completion.stale"));
});

test("changed output during verification requires a new model decision and check", async () => {
  let version = "old", checks = 0;
  const f = setup({ completionVersion: () => version, async verifyCompletion() {
    if (++checks === 1) version = "new";
    return pass();
  } });
  await f.controller.start();
  assert.equal(checks, 2);
  assert.equal(f.state.result, "answer-2");
});

test("stop during verification cannot be undone by a late passing verdict", async () => {
  const entered = gate(), release = gate();
  const f = setup({ async verifyCompletion() { entered.resolve(); await release.promise; return pass(); } });
  const running = f.controller.start();
  await Promise.race([entered.promise, running]);
  const stopped = f.controller.cancel();
  release.resolve();
  await stopped;
  assert.equal(f.state.status, "cancelled");
  assert.ok(!f.outcomes.some((o) => o.kind === "completed"));
});

test("checker errors require review and never silently count as a pass", async () => {
  const f = setup({ verifyCompletion: async () => { throw new Error("checker unavailable"); } });
  await f.controller.start();
  assert.equal(f.state.status, "needs_review");
  assert.ok(f.state.completion?.report.summary.includes("checker unavailable"));
});

test("human acceptance is tied to a pending result and its unchanged version", async () => {
  let version = "one";
  const f = setup({ completionVersion: () => version, verifyCompletion: async () => manual() });
  await f.controller.start();
  const id = f.state.completion?.id ?? "missing";
  version = "two";
  assert.throws(() => f.controller.acceptReview(id), { code: "STALE_REVIEW" });
  version = "one";
  f.controller.acceptReview(id);
  assert.equal(f.state.status, "completed");
  assert.equal(f.state.completion?.acceptedBy, "user");
  assert.throws(() => f.controller.acceptReview(id), { code: "STALE_REVIEW" });
});

test("a claimed pass with missing or unknown evidence cannot automatically complete", async () => {
  for (const report of [
    { verdict: "pass" as const, summary: "done", checks: [] },
    { ...manual(), verdict: "pass" as const },
  ]) {
    const f = setup({ verifyCompletion: async () => report });
    await f.controller.start();
    assert.equal(f.state.status, "needs_review");
  }
});

test("a new input from the check notification cannot commit the older answer", async () => {
  let changed = false;
  const f = setup({ event(type) {
    if (type === "completion.checked" && !changed) { changed = true; f.controller.enqueue("updated", "user"); }
  } });
  await f.controller.start();
  assert.equal(f.decisions(), 2);
  assert.equal(f.state.result, "answer-2");
});
