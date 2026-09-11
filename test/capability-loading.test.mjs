import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../server/harness.mjs";
import { validateTool } from "../server/tool-schema.mjs";
import { preserveToolResult } from "../server/tool-result.mjs";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-load-"));
  const h = new Harness({ root, speed: 0 });
  t.after(async () => {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const snapshot = h.create({ scenario: "custom", prompt: "检查隐私标注", autoStart: false });
  const s = h.get(snapshot.id),
    a = s.agents.main;
  return { h, s, a };
}
function add(h, name, body, resources = {}) {
  const lib = h.catalog.library;
  const p = lib.import({
    kind: "skill",
    source: "test",
    files: { "SKILL.md": `---\nname: ${name}\ndescription: ${name}\n---\n${body}`, ...resources },
  });
  return lib.resolve(p.id, { action: "keep", directories: ["root"] });
}
test("oversized skill load fails before committing any state; confirmed stage keeps global constraints", (t) => {
  const { h, s, a } = setup(t);
  const item = add(h, "long-skill", "原文要求".repeat(10000), {
    "global.md": "不得删除原始样本",
    "check.md": "检查标签",
  });
  const before = structuredClone(a.loadedSkills);
  assert.throws(() => h.capabilityLoader.load(s, a, "skill", item.name), { code: "CONTEXT_LIMIT" });
  assert.deepEqual(a.loadedSkills, before);
  assert.equal(a.skillSnapshots[item.name], undefined);
  h.catalog.library.update(item.id, {
    structure: { global: ["global.md"], stages: { 检查: ["check.md"] }, confirmed: true },
  });
  const loaded = h.capabilityLoader.load(s, a, "skill", item.name, "检查");
  assert.equal(loaded.loaded, true);
  assert.match(h.context.system(s, a), /不得删除原始样本/);
});
test("loaded resources and tool execution remain pinned after registry changes", async (t) => {
  const { h, s, a } = setup(t);
  const item = add(h, "versioned", "读取参考资料", { "ref.md": "旧版".repeat(2000) });
  h.capabilityLoader.load(s, a, "skill", item.name);
  const p = h.catalog.library.import({
    kind: "skill",
    source: "test",
    files: {
      "SKILL.md": "---\nname: versioned\ndescription: versioned\n---\n新说明",
      "ref.md": "新版",
    },
  });
  h.catalog.library.resolve(p.id, { action: "replace", directories: ["root"] });
  const read = h.capabilityLoader.read(a, item.name, "ref.md", 0, 10);
  assert.equal(read.version, item.version);
  assert.equal(read.content, "旧版".repeat(5));
  assert.equal(read.nextOffset, 10);
  h.capabilityLoader.load(s, a, "tool", "analytics__latency__mean");
  h.catalog.tools.get("analytics__latency__mean").op = "max";
  const result = await h.invoke(s, a, "analytics__latency__mean", { values: [2, 6] });
  assert.equal(result.value, 4);
  const bundled = h.catalog.library.get("privacy-boundary");
  const updated = h.catalog.library.import({
    kind: "skill",
    source: bundled.source,
    files: {
      ...h.catalog.library.package(bundled.id),
      "SKILL.md": h.catalog.library.package(bundled.id)["SKILL.md"] + "\n新增说明",
    },
  });
  assert.ok(updated.conflicts.some((c) => c.type === "update" && c.otherId === bundled.id));
});
test("dependency and confirmed conflict checks cannot expand permissions", (t) => {
  const { h, s, a } = setup(t);
  const first = add(h, "first", "保留原文"),
    second = add(h, "second", "替换原文");
  h.catalog.library.update(second.id, {
    dependencies: [{ name: "UnknownShell", required: true, origin: "author" }],
  });
  assert.throws(() => h.capabilityLoader.load(s, a, "skill", second.name), {
    code: "DEPENDENCY_MISSING",
  });
  h.catalog.library.update(second.id, { dependencies: [] });
  h.catalog.library.repo.put("relations", "test", {
    ids: [first.id, second.id],
    versions: [first.version, second.version],
    confirmed: true,
    type: "contradiction",
  });
  h.capabilityLoader.load(s, a, "skill", first.name);
  assert.throws(() => h.capabilityLoader.load(s, a, "skill", second.name), {
    code: "SKILL_CONFLICT",
  });
  assert.deepEqual(s.grants, []);
});
test("strict schemas reject unsupported constraints and long results preserve retrievable data", (t) => {
  const { h, s, a } = setup(t);
  assert.throws(() => validateTool({ type: "string", pattern: "^[a-z]+$" }, "A"), {
    code: "INVALID_ARGUMENT",
  });
  assert.throws(() => validateTool({ type: "string", unknownRule: true }, "a"), {
    code: "SCHEMA_UNSUPPORTED",
  });
  const value = {
    status: "ok",
    rows: Array.from({ length: 1000 }, (_, i) => ({ id: i, text: "详细资料".repeat(50) })),
  };
  const output = preserveToolResult(h, s, a, "large", value);
  assert.ok(output.artifactId);
  assert.deepEqual(JSON.parse(h.store.readArtifact(s.id, output.artifactId).content), value);
});
test("configured Node commands receive typed data and run under the existing process supervisor", async (t) => {
  const { h, s, a } = setup(t);
  h.capabilityLoader.load(s, a, "tool", "text_count");
  const result = await h.invoke(s, a, "text_count", { text: "中文\nabc" });
  assert.deepEqual(result.data, { characters: 6, lines: 2 });
  assert.equal(result.cleanup, "released");
  assert.equal(h.processes.list(s.id).length, 0);
});
test("imported tool declarations cannot create always-on command bindings", async (t) => {
  const { h, s, a } = setup(t),
    lib = h.catalog.library;
  const p = lib.import({
    kind: "tool",
    source: "untrusted",
    files: {
      "tool.json": JSON.stringify({
        format: "harness-capability-v1",
        name: "fake_command",
        description: "fake",
        tool: {
          always: true,
          adapter: "node-command-v1",
          binding: { entry: "/tmp/unknown", digest: "claimed" },
          parameters: { type: "object" },
        },
      }),
    },
  });
  const item = lib.resolve(p.id, { action: "keep", directories: ["root"] });
  assert.equal(item.enabled, false);
  assert.equal(h.catalog.getTool(item.name).always, false);
  await assert.rejects(h.invoke(s, a, item.name, {}), { code: "CAPABILITY_DISABLED" });
});
