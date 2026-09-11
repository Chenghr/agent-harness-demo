import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Harness } from "../server/harness.mjs";
import { createServer } from "../server/index.mjs";

test("management import, explicit decision, independent reports and shared HTTP loader work together", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-http-"));
  const h = new Harness({ root, speed: 0, env: {} }),
    app = createServer({ harness: h, port: 0 });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const call = async (route, body) => {
    const r = await fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, value: await r.json() };
  };
  const dir = await call("/management/directory", {
    action: "create",
    id: "review",
    parent: "root",
    name: "测试审查",
  });
  assert.equal(dir.status, 200);
  const incoming = {
    kind: "skill",
    source: "http-test",
    files: {
      "SKILL.md":
        "---\nname: http-review\ndescription: 检查样本定义\ntrusted: true\n---\n只读取给定定义，输出问题清单。",
    },
  };
  const pending = await call("/management/import", incoming);
  assert.equal(pending.status, 200);
  const original = await call("/management/import/" + pending.value.id);
  assert.equal(original.value.files["SKILL.md"], incoming.files["SKILL.md"]);
  const rejected = await call("/management/item/" + pending.value.record.id, { enabled: true });
  assert.equal(rejected.status, 400);
  const resolved = await call("/management/resolve", {
    ids: [pending.value.id],
    decision: { action: "keep", directories: ["review"] },
  });
  assert.equal(resolved.value.results[0].item.trust.trusted, false);
  const tree = await call("/management/directory?id=review");
  assert.equal(tree.value.total, 1);
  const id = resolved.value.results[0].item.id;
  const quality = await call("/management/evaluate", { ids: [id], kind: "quality" });
  await h.evaluations.wait(quality.value.id);
  const detail = await call("/management/item/" + id);
  assert.equal(detail.value.reports[0].overall, null);
  const session = h.create({ scenario: "custom", prompt: "检查样本定义", autoStart: false });
  const loaded = await call(`/sessions/${session.id}/load`, { kind: "skill", name: "http-review" });
  assert.equal(loaded.status, 200);
  assert.ok(h.get(session.id).agents.main.loadedSkills.includes("http-review"));
  const duplicate = await call("/management/import", incoming);
  assert.equal(duplicate.value.conflicts[0].type, "duplicate");
  const malformed = await call("/management/item/" + id, { title: { bad: true } });
  assert.equal(malformed.status, 400);
  const model = await call("/management/evaluate", {
    ids: [id],
    kind: "quality",
    model: "api-primary",
  });
  assert.equal(model.value.error.code, "MODEL_UNCONFIGURED");
});
