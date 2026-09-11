import test from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "../server/runtime/agent-loop.ts";
import { RuntimeFault } from "../server/runtime/contracts.ts";
import type { ExecutionLease, LoopPorts, ToolCall } from "../server/runtime/contracts.ts";

function setup(overrides: Partial<LoopPorts<string, string>> = {}) {
  const abort = new AbortController();
  const lease: ExecutionLease = {
    epoch: 1, signal: abort.signal,
    isActive: () => !abort.signal.aborted,
    assertActive() { if (abort.signal.aborted) throw new RuntimeFault("CANCELLED", "cancelled"); },
  };
  const results: Array<{ call: string; result: unknown }> = [];
  const invoked: string[] = [], events: string[] = [], closed: string[] = [];
  const ports: LoopPorts<string, string> = {
    prepare: async () => "context",
    complete: async () => ({ text: "answer", calls: [] }),
    openExchange: () => "exchange",
    appendResult: (_, call, result) => { results.push({ call: call.id, result }); },
    closeExchange: (exchange) => { closed.push(exchange); },
    invoke: async (call) => { invoked.push(call.id); return { ok: true }; },
    statusChanged: () => {},
    event: (type) => { events.push(type); },
    ...overrides,
  };
  return { loop: new AgentLoop(ports), abort, lease, results, invoked, events, closed };
}
function call(id: string, args = "{}"): ToolCall {
  return { id, type: "function", function: { name: "test_tool", arguments: args } };
}

test("cancellation during input preparation prevents the model request", async () => {
  let requested = false;
  const { loop, abort, lease } = setup({
    async prepare() { abort.abort(); return "stale context"; },
    async complete() { requested = true; return {}; },
  });
  await assert.rejects(loop.step(lease), { code: "CANCELLED" });
  assert.equal(requested, false);
});

test("late streamed output and tool requests are rejected after cancellation", async () => {
  let opened = false;
  const { loop, abort, lease, invoked, events } = setup({
    async complete(_, __, onDelta) {
      abort.abort();
      onDelta("late text");
      return { calls: [call("late-tool")] };
    },
    openExchange() { opened = true; return "exchange"; },
  });
  await assert.rejects(loop.step(lease), { code: "CANCELLED" });
  assert.equal(opened, false);
  assert.deepEqual(invoked, []);
  assert.deepEqual(events, ["model.stale"]);
});

test("a redirect from the thinking notification prevents request dispatch", async () => {
  let requested = false;
  const { loop, abort, lease } = setup({
    statusChanged(status) { if (status === "thinking") abort.abort(); },
    async complete() { requested = true; return {}; },
  });
  await assert.rejects(loop.step(lease), { code: "CANCELLED" });
  assert.equal(requested, false);
});

test("completed effects survive cancellation and remaining calls receive paired results", async () => {
  const effects: string[] = [];
  const { loop, abort, lease, results, closed } = setup({
    complete: async () => ({ calls: [call("write"), call("next"), call("last")] }),
    async invoke(call) {
      effects.push(call.id);
      abort.abort();
      return { saved: true };
    },
  });
  await assert.rejects(loop.step(lease), { code: "CANCELLED" });
  assert.deepEqual(effects, ["write"]);
  assert.deepEqual(results.map((result) => result.call), ["write", "next", "last"]);
  assert.deepEqual(results[0]?.result, { saved: true });
  for (const result of results.slice(1))
    assert.equal((result.result as { error: { code: string } }).error.code, "CANCELLED");
  assert.deepEqual(closed, ["exchange"]);
});

test("incomplete tool JSON produces an error result without invoking that tool", async () => {
  const { loop, lease, results, invoked, closed } = setup({
    complete: async () => ({ calls: [call("invalid", '{"path":'), call("valid")] }),
  });
  assert.deepEqual(await loop.step(lease), { kind: "continue" });
  assert.deepEqual(invoked, ["valid"]);
  assert.equal((results[0]!.result as { error: { code: string } }).error.code, "INVALID_ARGUMENT");
  assert.deepEqual(closed, ["exchange"]);
});
