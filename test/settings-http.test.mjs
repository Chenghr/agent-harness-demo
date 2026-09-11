import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Harness } from "../server/harness.mjs";
import { createServer } from "../server/index.mjs";
test("browser APIs configure, discover and test a model without returning a saved secret", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-http-"));
  const seen = [];
  const provider = http.createServer(async (req, res) => {
    seen.push(req.headers.authorization);
    if (req.url === "/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    const input = JSON.parse(body);
    assert.equal(input.model, "fixture");
    assert.equal(input.max_tokens, 1000);
    assert.equal(input.max_completion_tokens, undefined);
    const complete = input.messages.some((m) => m.role === "tool");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta: complete
                ? { content: "连接成功" }
                : {
                    tool_calls: [
                      {
                        index: 0,
                        id: "probe",
                        type: "function",
                        function: { name: "connection_probe", arguments: '{"ok":true}' },
                      },
                    ],
                  },
              finish_reason: complete ? "stop" : "tool_calls",
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const h = new Harness({ root: path.join(root, "state"), speed: 0 });
  const app = createServer({ harness: h, port: 0 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await new Promise((r) => provider.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = async (route, body) => {
    const r = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api${route}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const result = await r.json();
    assert.equal(r.status, 200, JSON.stringify(result));
    assert(!JSON.stringify(result).includes("test-private-key"));
    return result;
  };
  const p = await request("/settings/providers", {
    name: "test",
    baseUrl: `http://127.0.0.1:${provider.address().port}`,
    protocol: "chat-completions",
    apiKey: "test-private-key",
  });
  const m = await request("/settings/models", {
    providerId: p.id,
    modelName: "fixture",
    contextWindow: 16000,
    maxOutput: 1000,
    maxTokensField: "max_tokens",
    tools: true,
  });
  const discovered = await request("/settings/discover", { providerId: p.id });
  assert.equal(discovered.models[0].id, "fixture");
  const result = await request("/settings/test", { modelId: m.id });
  assert(result.toolRoundTrip);
  await request("/settings/models");
  await request("/config");
  assert(seen.every((v) => v === "Bearer test-private-key"));
});
