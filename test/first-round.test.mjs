import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../server/harness.mjs";
import { deferred, delay } from "../server/core.mjs";

function setup(t, modelAdapter, unblock = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-first-round-"));
  // These tests isolate input/lifecycle behavior; concrete outcome checks have their own suite.
  const completionCheck = async () => ({ verdict: "pass", summary: "Lifecycle test rule passed", checks: [{ name: "test", status: "passed", detail: "Controlled fixture" }] });
  const h = new Harness({ root, speed: 0, env: {}, modelAdapter, completionCheck });
  t.after(async () => {
    unblock();
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return h;
}

async function drained(h) {
  const end = Date.now() + 3000;
  do {
    if (Date.now() > end) throw new Error("Task did not settle");
    await delay(5);
  } while (h.controls.size);
}

test("an append arriving during the final model request is consumed before completion", async (t) => {
  const entered = deferred(), release = deferred();
  const inputs = [];
  const h = setup(t, {
    async complete({ input }) {
      inputs.push(JSON.stringify(input.messages));
      if (inputs.length === 1) { entered.resolve(); await release.promise; }
      return { text: inputs.length === 1 ? "old answer" : "updated answer", calls: [] };
    },
  }, () => release.resolve());
  const s = h.get(h.create().id);
  await entered.promise;
  h.message(s.id, "APPEND_EVIDENCE: exclude names", "append");
  release.resolve();
  await drained(h);
  assert.equal(inputs.length, 2);
  assert.ok(inputs[1].includes("APPEND_EVIDENCE"));
  assert.equal(s.agents.main.pendingMessages.length, 0);
  assert.equal(s.agents.main.result, "updated answer");
  assert.equal(s.status, "completed");
});

for (const outcome of ["completed", "failed"]) {
  test(`a child ${outcome} during the final request is delivered before the parent completes`, async (t) => {
    const entered = deferred(), release = deferred(), childFinished = deferred();
    const inputs = [];
    const h = setup(t, {
      async complete({ agent, input }) {
        if (agent.parentId) {
          if (outcome === "failed") throw new Error("CHILD_FAILURE_EVIDENCE");
          return { text: "CHILD_SUCCESS_EVIDENCE", calls: [] };
        }
        inputs.push(JSON.stringify(input.messages));
        if (inputs.length === 1) { entered.resolve(); await release.promise; }
        return { text: "parent answer", calls: [] };
      },
    }, () => release.resolve());
    h.on("event", (event) => {
      if (event.agentId !== "main" && event.type === `agent.${outcome}`) childFinished.resolve();
    });
    const s = h.get(h.create().id);
    await entered.promise;
    h.spawnAgent(s, s.agents.main, "inspect input");
    await childFinished.promise;
    release.resolve();
    await drained(h);
    assert.equal(inputs.length, 2);
    assert.ok(inputs[1].includes(outcome === "failed" ? "CHILD_FAILURE_EVIDENCE" : "CHILD_SUCCESS_EVIDENCE"));
    assert.equal(s.agents.main.pendingMessages.length, 0);
    assert.equal(s.status, "completed");
  });
}

test("a message accepted at the completion notification opens another run without loss", async (t) => {
  const inputs = [];
  const h = setup(t, {
    async complete({ input }) {
      inputs.push(JSON.stringify(input.messages));
      return { text: "answer", calls: [] };
    },
  });
  let sent = false;
  h.on("event", (event) => {
    if (event.type === "agent.completed" && event.agentId === "main" && !sent) {
      sent = true;
      h.message(event.sessionId, "FOLLOWUP_AFTER_COMPLETION", "append");
    }
  });
  const s = h.get(h.create().id);
  await drained(h);
  assert.equal(inputs.length, 2);
  assert.ok(inputs[1].includes("FOLLOWUP_AFTER_COMPLETION"));
  assert.equal(s.agents.main.pendingMessages.length, 0);
  assert.equal(s.status, "completed");
});

test("a late final response after stop cannot complete or dispatch more work", async (t) => {
  const entered = deferred(), release = deferred();
  const h = setup(t, {
    async complete() {
      entered.resolve();
      await release.promise; // Deliberately ignores cancellation, like a late remote response.
      return { text: "late answer", calls: [] };
    },
  }, () => release.resolve());
  const s = h.get(h.create().id);
  await entered.promise;
  const stopping = h.stop(s.id);
  release.resolve();
  await stopping;
  await drained(h);
  assert.equal(s.status, "cancelled");
  assert.ok(!h.store.events(s.id).some((e) => e.type === "session.completed"));
  assert.equal(s.stats.toolCalls, 0);
});

test("steering at input admission preserves the already accepted child evidence", async (t) => {
  const entered = deferred(), release = deferred();
  const inputs = [];
  const h = setup(t, {
    async complete({ input }) {
      inputs.push(JSON.stringify(input.messages));
      if (inputs.length === 1) { entered.resolve(); await release.promise; }
      return { text: "answer", calls: [] };
    },
  }, () => release.resolve());
  const s = h.get(h.create().id);
  await entered.promise;
  h.controller(s, s.agents.main).enqueue("ACCEPTED_CHILD_EVIDENCE", "child");
  let steered = false;
  h.on("event", (event) => {
    if (event.type === "inbox.consumed" && event.data.source === "child" && !steered) {
      steered = true;
      h.message(s.id, "change presentation order", "steer");
    }
  });
  release.resolve();
  await drained(h);
  assert.equal(inputs.length, 2);
  assert.ok(inputs[1].includes("ACCEPTED_CHILD_EVIDENCE"));
  assert.equal(s.status, "completed");
});
