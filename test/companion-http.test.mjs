import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../server/harness.mjs";
import { createServer } from "../server/index.mjs";
test("companion HTTP reads, persists feedback, exports and clears without main task writes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-http-")),
    h = new Harness({ root, env: {}, speed: 0 }),
    app = createServer({ harness: h });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}/api`,
    post = (route, body) =>
      fetch(base + route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
  const s = h.create({ autoStart: false }),
    route = `/sessions/${s.id}/companion`;
  assert.equal((await fetch(base + route)).status, 200);
  const answer = await (await post(route + "/messages", { text: "进展" })).json();
  assert.ok(answer.id);
  const feedback = await post(route + "/feedback", {
    kind: "down",
    target: { type: "companion", id: answer.id },
  });
  assert.equal(feedback.status, 201);
  const exported = await (await fetch(base + route + "/export")).json();
  assert.equal(exported.feedback.length, 1);
  assert.equal(exported.messages.length, 2);
  assert.equal((await post(route + "/feedback", { kind: "unknown" })).status, 400);
  assert.equal((await post(route + "/clear", {})).status, 200);
  assert.equal(h.get(s.id).agents.main.history.length, 1);
});
test("closing the request cancels only its owned companion model call", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-disconnect-")),
    h = new Harness({ root, env: {}, speed: 0 }),
    app = createServer({ harness: h });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const s = h.create({ autoStart: false });
  h.models.profiles[0].simulated = false;
  let entered;
  const started = new Promise((r) => (entered = r));
  h.apiModel.complete = ({ signal }) => {
    entered();
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  };
  const controller = new AbortController();
  const p = fetch(
    `http://127.0.0.1:${app.server.address().port}/api/sessions/${s.id}/companion/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
      signal: controller.signal,
    },
  );
  await started;
  controller.abort();
  await assert.rejects(p);
  for (let i = 0; i < 100 && h.companion.active.size; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.companion.active.size, 0);
  assert.equal(h.get(s.id).status, "idle");
});
