import test from "node:test";
import assert from "node:assert/strict";
import { TaskController } from "../server/runtime/task-controller.ts";
import type {
  ControllerPorts, ControlState, InboxMessage, RunOutcome,
} from "../server/runtime/contracts.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(overrides: Partial<ControllerPorts> = {}) {
  const state: ControlState = {
    epoch: 0, status: "idle", result: null, pendingModel: null, pendingMessages: [],
  };
  const admitted: InboxMessage[] = [];
  const outcomes: RunOutcome[] = [];
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  let messageId = 0;
  const ports: ControllerPorts = {
    isScopeOpen: () => true,
    admitInput: (messages) => { admitted.push(...messages); },
    step: async () => ({ kind: "candidate", text: "answer" }),
    hasPendingWork: () => false,
    completionVersion: () => "unchanged",
    verifyCompletion: async () => ({ verdict: "pass", summary: "test rule passed", checks: [{ name: "test", status: "passed", detail: "verified" }] }),
    waitForWork: async () => {},
    cancelDescendants: async () => {},
    advanced: () => {},
    statusChanged: () => {},
    settled: (outcome) => { outcomes.push(outcome); },
    released: () => {},
    event: (type, data) => { events.push({ type, data }); },
    messageId: () => `input-${++messageId}`,
    ...overrides,
  };
  return { controller: new TaskController(state, ports), state, admitted, outcomes, events };
}

test("repeated wakeups share one driver and one model decision", async () => {
  const entered = gate(), release = gate();
  let decisions = 0;
  const { controller, state } = setup({
    async step() {
      decisions++;
      entered.resolve();
      await release.promise;
      return { kind: "candidate", text: "done" };
    },
  });
  const running = controller.start();
  await entered.promise;
  assert.equal(controller.start(), running);
  assert.equal(controller.start(), running);
  release.resolve();
  await running;
  assert.equal(decisions, 1);
  assert.equal(state.status, "completed");
  assert.equal(controller.running, false);
});

test("successive redirects wait for the old driver and admit both inputs in order", async () => {
  const entered = gate(), release = gate();
  const epochs: number[] = [];
  let concurrent = 0, maxConcurrent = 0;
  const { controller, state, admitted, outcomes } = setup({
    async step(lease) {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      epochs.push(lease.epoch);
      if (epochs.length === 1) { entered.resolve(); await release.promise; }
      concurrent--;
      return { kind: "candidate", text: `epoch-${lease.epoch}` };
    },
  });
  const old = controller.start();
  await entered.promise;
  controller.enqueue("first adjustment", "user");
  controller.redirect();
  controller.enqueue("latest adjustment", "user");
  controller.redirect();
  assert.equal(epochs.length, 1);
  release.resolve();
  await old;
  await controller.completion;
  assert.equal(epochs.length, 2);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(admitted.map((message) => message.content), ["first adjustment", "latest adjustment"]);
  assert.equal(outcomes.length, 1);
  assert.equal(state.result, `epoch-${epochs[1]}`);
});

test("stop discards unadmitted input explicitly and cannot be undone by a late decision", async () => {
  const entered = gate(), release = gate();
  const { controller, state, admitted, events } = setup({
    async step() {
      entered.resolve();
      await release.promise;
      return { kind: "candidate", text: "late" };
    },
  });
  controller.start();
  await entered.promise;
  const message = controller.enqueue("queued", "user");
  const stopped = controller.cancel();
  release.resolve();
  await stopped;
  assert.equal(state.status, "cancelled");
  assert.equal(admitted.length, 0);
  assert.equal(state.pendingMessages.length, 0);
  assert.ok(events.some((event) => event.type === "inbox.discarded"
    && (event.data.message as InboxMessage).id === message.id));
});

test("a completion candidate waits for owned work and reads its result before finishing", async () => {
  const waiting = gate(), release = gate();
  let pending = true, decisions = 0;
  const { controller, state, admitted, outcomes } = setup({
    async step() { return { kind: "candidate", text: `decision-${++decisions}` }; },
    hasPendingWork: () => pending,
    async waitForWork() { waiting.resolve(); await release.promise; },
  });
  const running = controller.start();
  await waiting.promise;
  assert.equal(state.status, "waiting");
  assert.equal(outcomes.length, 0);
  controller.enqueue("background validation failed", "child");
  pending = false;
  release.resolve();
  await running;
  assert.equal(admitted[0]?.source, "child");
  assert.equal(state.result, "decision-2");
});

test("pending model handoff blocks completion and gets another decision", async () => {
  let decisions = 0;
  const { controller, state } = setup({
    async step() {
      decisions++;
      state.pendingModel = decisions === 1 ? "next-model" : null;
      return { kind: "candidate", text: `decision-${decisions}` };
    },
  });
  await controller.start();
  assert.equal(decisions, 2);
  assert.equal(state.result, "decision-2");
});
