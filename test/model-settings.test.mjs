import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelRegistry } from "../server/models.mjs";

test("web model settings persist independent providers without returning credentials", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = new ModelRegistry({}, root);
  const p = r.settings.saveProvider({
    name: "Local",
    baseUrl: "http://localhost:8080/v1",
    protocol: "chat-completions",
    apiKey: "secret-only-local",
  });
  const m = r.settings.saveModel({
    providerId: p.id,
    modelName: "test-model",
    contextWindow: 16000,
    maxOutput: 1000,
    tools: true,
    effort: "high",
    reasoningEfforts: ["high"],
    maxTokensField: "max_tokens",
  });
  assert(!JSON.stringify(r.settings.list()).includes("secret-only-local"));
  assert.equal(r.get(m.id).contextWindow, 16000);
  const pinned = r.get(m.id);
  r.settings.saveProvider({ ...p, apiKey: "replacement" });
  assert.equal(pinned.connection.key, "secret-only-local");
  assert.equal(r.get(m.id).connection.key, "replacement");
  const next = new ModelRegistry({}, root);
  assert.equal(next.get(m.id).modelName, "test-model");
  assert.equal(fs.statSync(path.join(root, "credentials.json")).mode & 0o777, 0o600);
  assert.throws(() => r.settings.saveModel({ ...m, maxOutput: 20000 }), /输出/);
  assert.throws(
    () => r.settings.saveProvider({ ...p, baseUrl: "https://user:password@example.com" }),
    /地址/,
  );
});
