import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../server/harness.mjs";
import { createServer } from "../server/index.mjs";
import { delay } from "../server/core.mjs";

test(
  "HTTP delegation validates scope and returns the configured assistant result",
  { timeout: 10000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-delegation-http-"));
    const h = new Harness({
      root,
      env: {},
      speed: 0,
      modelAdapter: {
        async complete() {
          return { text: "材料检查结果", calls: [] };
        },
      },
    });
    const app = createServer({ harness: h });
    t.after(async () => {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}/api`;
    const post = (route, body) =>
      fetch(base + route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const session = await (
      await post("/sessions", { scenario: "custom", autoStart: false, prompt: "核对说明" })
    ).json();
    fs.writeFileSync(path.join(h.get(session.id).workspace, "notes.txt"), "公开说明");
    const route = `/sessions/${session.id}/agents`;
    assert.equal(
      (await post(route, { goal: "不能自己授予权限", tools: ["file_write"] })).status,
      400,
    );
    assert.equal((await post(route, { goal: "未知助手", type: "missing" })).status, 400);
    const response = await post(route, {
      goal: "核对说明",
      type: "analysis",
      files: ["notes.txt"],
      mode: "foreground",
      model: "demo-focused",
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.ok(result.resultId);
    assert.equal(result.status, "needs_review");
    assert.equal(result.model, "demo-focused");
    assert.equal(result.cleanup, "released");
    const child = h.snapshot(session.id).agents[result.agentId];
    assert.equal(child.delegation.mode, "foreground");
    assert.deepEqual(
      child.delegation.materials.map((m) => m.path),
      ["notes.txt"],
    );
  },
);

test(
  "HTTP config, sessions, catalog, streaming reconnect and local origin guard",
  { timeout: 15000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-http-"));
    const h = new Harness({ root, speed: 0, env: {} });
    const app = createServer({ harness: h });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}/api`;
    t.after(async () => {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const config = await fetch(base + "/config").then((r) => r.json());
    assert.ok(config.counts.tools > 1000);
    assert.ok(!JSON.stringify(config).includes("API_KEY"));
    const search = await fetch(base + "/catalog?kind=tool&q=analytics__latency__mean").then((r) =>
      r.json(),
    );
    assert.equal(search.items[0].name, "analytics__latency__mean");
    const denied = await fetch(base + "/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://untrusted.invalid" },
      body: "{}",
    });
    assert.equal(denied.status, 403);
    const create = await fetch(base + "/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "security" }),
    });
    assert.equal(create.status, 201);
    const session = await create.json();
    const ctrl = new AbortController();
    const response = await fetch(base + `/sessions/${session.id}/stream`, { signal: ctrl.signal });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.ok(new TextDecoder().decode(first.value).includes("event: state"));
    await reader.cancel();
    ctrl.abort();
    const reconnect = new AbortController();
    const second = await fetch(base + `/sessions/${session.id}/stream`, {
      headers: { "Last-Event-ID": "1" },
      signal: reconnect.signal,
    });
    const secondReader = second.body.getReader();
    const next = await secondReader.read();
    assert.ok(new TextDecoder().decode(next.value).includes(session.id));
    await secondReader.cancel();
    reconnect.abort();
    const stop = await fetch(base + `/sessions/${session.id}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(stop.status, 200);
    const stopped = await stop.json();
    assert.equal(stopped.resources.length, 0);
    assert.equal(stopped.status, "cancelled");
    const invalid = await fetch(base + "/sessions/not-real");
    assert.equal(invalid.status, 404);
  },
);

test(
  "HTTP review uses a fresh result token and persists explicit human acceptance",
  { timeout: 10000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-review-http-"));
    const h = new Harness({
      root,
      speed: 0,
      env: {},
      modelAdapter: {
        async complete() {
          return { text: "待验收结果", calls: [] };
        },
      },
    });
    const app = createServer({ harness: h });
    let restored;
    t.after(async () => {
      await restored?.close();
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}/api`;
    const post = (route, body) =>
      fetch(base + route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const s = await (await post("/sessions", { scenario: "custom", prompt: "检查材料" })).json();
    const deadline = Date.now() + 4000;
    while (h.controls.size) {
      assert.ok(Date.now() < deadline);
      await delay(5);
    }
    const pending = await fetch(base + `/sessions/${s.id}`).then((r) => r.json());
    assert.equal(pending.status, "needs_review");
    const reviewId = pending.agents.main.completion.id;
    assert.equal(
      (await post(`/sessions/${s.id}/review`, { reviewId: "old", decision: "accept" })).status,
      409,
    );
    const accepted = await post(`/sessions/${s.id}/review`, { reviewId, decision: "accept" });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).agents.main.completion.acceptedBy, "user");
    assert.equal(
      (await post(`/sessions/${s.id}/review`, { reviewId, decision: "accept" })).status,
      409,
    );
    assert.equal(h.get(s.id).grants.length, 0);
    restored = new Harness({ root, env: {} });
    assert.equal(restored.get(s.id).status, "completed");
    assert.equal(restored.get(s.id).agents.main.completion.acceptedBy, "user");
  },
);
