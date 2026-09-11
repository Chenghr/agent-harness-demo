import assert from "node:assert/strict";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

// Run against the local delivery server. Only approve the new fixture task created here.
const base = "http://127.0.0.1:4317";
async function api(route, body) {
  const response = await fetch(
    base + "/api" + route,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}
const page = await fetch(base);
assert.equal(page.status, 200);
const html = await page.text();
assert.ok(html.includes("Harness Lab"));
const assets = [
  ...new Set([...html.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css|svg))"/g)].map((m) => m[1])),
];
assert.ok(assets.length > 0);
for (const asset of assets) {
  const url = new URL(asset, base);
  assert.equal(url.origin, base);
  assert.equal((await fetch(url)).status, 200, asset);
}
const initial = await api("/sessions", {
  scenario: "full",
  model: "demo-balanced",
});
let session,
  done = false;
try {
  const deadline = Date.now() + 60000;
  do {
    session = await api("/sessions/" + initial.id);
    for (const approval of session.approvals.filter((a) => a.status === "pending")) {
      assert.equal(approval.tool, "file_write");
      assert.equal(approval.args.path, "cart.mjs");
      await api(`/sessions/${initial.id}/approvals/${approval.id}`, { decision: "once" });
    }
    if (["completed", "failed", "cancelled", "needs_review"].includes(session.status)) break;
    assert.ok(Date.now() < deadline, "Delivery smoke timed out");
    await delay(150);
  } while (!["completed", "failed", "cancelled", "needs_review"].includes(session.status));
  assert.equal(session.status, "completed");
  assert.equal(session.stats.failed, 0);
  assert.equal(session.resources.length, 0);
  const tests = session.actions.filter((a) => a.tool === "run_tests" && a.agentId === "main");
  assert.equal(tests[0].result.exitCode, 1);
  assert.equal(tests.at(-1).result.exitCode, 0);
  session = await api(`/sessions/${initial.id}/model`, { model: "demo-focused" });
  assert.equal(session.model, "demo-focused");
  assert.equal(session.handoffs.length, 1);
  const report = {
    createdAt: new Date().toISOString(),
    base,
    staticAssets: assets.length,
    scenario: session.scenario,
    status: session.status,
    toolCalls: session.stats.toolCalls,
    testsBefore: tests[0].result.exitCode,
    testsAfter: tests.at(-1).result.exitCode,
    liveResources: session.resources.length,
    modelHandoffs: session.handoffs.length,
    browserInteractionTested: false,
  };
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/smoke.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  done = true;
} finally {
  if (!done) await api(`/sessions/${initial.id}/stop`).catch(() => {});
}
