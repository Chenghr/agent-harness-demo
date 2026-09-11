import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../server/harness.mjs";
import {
  PRIVACY_SOURCE,
  PRIVACY_RULES,
  PRIVACY_DATA,
  checkPrivacyDataset,
} from "../server/privacy-demo.mjs";
test("privacy sample validates code point boundaries and rejects altered text or missing entities", () => {
  const verify = (rows) =>
    checkPrivacyDataset(
      JSON.stringify(PRIVACY_SOURCE, null, 2),
      PRIVACY_RULES,
      JSON.stringify(rows),
    );
  assert.deepEqual(verify(PRIVACY_DATA), []);
  const wrong = structuredClone(PRIVACY_DATA);
  wrong[0].entities[0].start++;
  assert.ok(verify(wrong).length);
  const missing = structuredClone(PRIVACY_DATA);
  missing[0].entities = [];
  assert.ok(verify(missing).length);
  const altered = structuredClone(PRIVACY_DATA);
  altered[0].text += "changed";
  assert.ok(verify(altered).length);
});
test("privacy demo writes an actual dataset behind approval and checks the artifact independently", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-demo-"));
  const h = new Harness({ root, speed: 0, env: {} });
  t.after(async () => {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  h.on("event", (e) => {
    if (e.type === "approval.requested")
      queueMicrotask(() => h.approve(e.sessionId, e.data.id, "once"));
  });
  const s = h.get(h.create({ scenario: "privacy" }).id);
  for (let i = 0; i < 500 && !["completed", "failed", "needs_review"].includes(s.status); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.status, "completed");
  assert.equal(s.approvals.length, 1);
  assert.equal(s.agents.main.completion.report.verdict, "pass");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(s.workspace, "dataset.json"), "utf8")),
    PRIVACY_DATA,
  );
  assert.ok(s.artifacts.some((a) => a.name === "dataset-check.json"));
  assert.equal(fs.existsSync(path.join(s.workspace, "cart.mjs")), false);
});
