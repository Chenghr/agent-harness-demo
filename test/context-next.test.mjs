import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../server/harness.mjs";
import { ModelRegistry } from "../server/models.mjs";
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-next-"));
  const h = new Harness({ root, speed: 0 });
  t.after(async () => {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const s = h.get(
    h.create({ autoStart: false, prompt: "构建隐私实体数据集，禁止修改原文；end 为不包含末尾。" })
      .id,
  );
  return { h, s, a: s.agents.main };
}
test("handoff preserves older unsummarized evidence and pending questions", async (t) => {
  const { h, s, a } = setup(t);
  h.context.add(s, a, [
    { role: "assistant", content: "已经检查样本 A17；待确认：邮箱中的加号是否保留。" },
  ]);
  for (let i = 0; i < 8; i++) h.context.add(s, a, [{ role: "assistant", content: "进展 " + i }]);
  await h.requestSwitch(s.id, "demo-focused");
  const input = h.context.build(s, a, h.models.get(a.model));
  assert.match(JSON.stringify(input.messages), /A17/);
  assert.match(JSON.stringify(input.messages), /加号是否保留/);
  assert.match(JSON.stringify(input.messages), /禁止修改原文/);
});
test("compression scales to target window and reports separate fixed/history budgets", async (t) => {
  const { h, s, a } = setup(t);
  for (let i = 0; i < 12; i++)
    h.context.add(s, a, [
      { role: "tool", tool_call_id: "call" + i, content: "证据 " + i + " 数据".repeat(1000) },
    ]);
  const before = h.context.build(s, a, h.models.get(a.model));
  const result = await h.context.compact(s, a, { delayMs: 0 });
  const after = h.context.build(s, a, h.models.get(a.model));
  assert.ok(after.tokens < before.tokens);
  assert.ok(result.targetTokens <= after.available);
  assert.ok(after.breakdown.tools > 0);
  assert.ok(after.breakdown.history > 0);
  assert.ok(after.margin > 0);
  assert.ok(result.archiveId);
  assert.match(h.store.readArtifact(s.id, result.archiveId).content, /证据 0/);
});
test("compression preserves history appended while summarization is pending", async (t) => {
  const { h, s, a } = setup(t);
  for (let i = 0; i < 8; i++)
    h.context.add(s, a, [{ role: "assistant", content: "历史 " + i + " ".repeat(700) }]);
  const p = h.context.compact(s, a, { delayMs: 30 });
  const unit = h.context.add(s, a, [{ role: "user", content: "新收到的子任务证据 B42" }]);
  await p;
  assert.ok(a.history.some((u) => u.id === unit.id));
});
test("large recent tool exchanges compact to capacity without archiving an unfinished exchange", async (t) => {
  const { h, s, a } = setup(t);
  const units = [];
  for (let i = 0; i < 4; i++) units.push(h.context.add(s, a, [
    { role: "assistant", content: null, tool_calls: [{ id: `large-${i}`, type: "function", function: { name: "file_read", arguments: '{"path":"evidence.txt"}' } }] },
    { role: "tool", tool_call_id: `large-${i}`, content: `证据${i}：` + "证".repeat(5000) },
  ]));
  const pending = h.context.add(s, a, [{ role: "assistant", content: "尚未收到结果", tool_calls: [{ id: "pending", type: "function", function: { name: "file_read", arguments: '{"path":"pending.txt"}' } }] }], false);
  const result = await h.context.compact(s, a, { delayMs: 0 });
  assert.ok(result.archiveId);
  assert.ok(h.context.build(s, a, h.models.get(a.model)).tokens <= result.targetTokens);
  assert.ok(a.history.includes(pending));
  assert.ok(a.history.includes(units.at(-1)));
  const archive = JSON.parse(h.store.readArtifact(s.id, result.archiveId).content);
  assert.ok(archive.units.every(u => u.complete));
  assert.ok(archive.units.some(u => u.id === units[0].id));
  assert.ok(!archive.units.some(u => u.id === pending.id));
});
test("insufficient fixed context fails without replacing history or summary", async (t) => {
  const { h, s, a } = setup(t);
  for (let i = 0; i < 8; i++) h.context.add(s, a, [{ role: "assistant", content: "history " + i }]);
  const original = a.history,
    summary = a.summary;
  h.models.profiles.find((p) => p.id === a.model).contextWindow = 2100;
  const result = await h.context.compact(s, a, { delayMs: 0 });
  assert.equal(result.skipped, true);
  assert.equal(a.history, original);
  assert.equal(a.summary, summary);
});
test("history search pages old matches and reads full event by sequence", async (t) => {
  const { h, s, a } = setup(t);
  for (let i = 0; i < 14; i++)
    h.context.add(s, a, [{ role: "assistant", content: "needle evidence " + i }]);
  const first = await h.invoke(s, a, "history_search", { query: "needle", limit: 4 });
  const second = await h.invoke(s, a, "history_search", {
    query: "needle",
    limit: 4,
    after: first.nextAfter,
  });
  assert.equal(first.events.length, 4);
  assert.ok(second.events[0].seq > first.events.at(-1).seq);
  const detail = await h.invoke(s, a, "history_search", { seq: first.events[0].seq });
  assert.match(detail.content, /needle evidence 0/);
});
test("real models have independent context and output configuration", () => {
  const r = new ModelRegistry({
    LLM_MODEL: "a",
    LLM_MODEL_ALT: "b",
    LLM_API_KEY: "test",
    LLM_CONTEXT_WINDOW: "32000",
    LLM_CONTEXT_WINDOW_ALT: "8000",
    LLM_MAX_OUTPUT: "2000",
    LLM_MAX_OUTPUT_ALT: "1000",
  });
  assert.equal(r.get("api-secondary").contextWindow, 8000);
  assert.equal(r.get("api-secondary").maxOutput, 1000);
});
test("model summary uses only complete source records, validates references, and commits appended evidence", async (t) => {
  const { h, s, a } = setup(t);
  h.models.profiles[0].simulated = false;
  for (let i = 0; i < 8; i++)
    h.context.add(s, a, [{ role: "assistant", content: "原始证据 " + i + " ".repeat(1000) }]);
  let release, enter;
  const entered = new Promise((r) => (enter = r));
  const wait = new Promise((r) => (release = r));
  h.apiModel.complete = async ({ input, profile }) => {
    assert.equal(input.tools.length, 0);
    assert.ok(profile.maxOutput <= h.models.profiles[0].maxOutput);
    enter();
    await wait;
    return { text: `待确认邮箱中的加号 [${a.history[1].id}]`, calls: [] };
  };
  const compact = h.context.compact(s, a, { delayMs: 0 });
  await entered;
  const latest = h.context.add(s, a, [{ role: "user", content: "新的样本 B88" }]);
  release();
  const result = await compact;
  assert.equal(result.method, "model-with-archive");
  assert.match(a.summary, /加号/);
  assert.ok(a.history.some((u) => u.id === latest.id));
});
test("oversized or invalid model summaries fall back without trusting invented source references", async (t) => {
  const { h, s, a } = setup(t);
  h.models.profiles[0].simulated = false;
  for (let i = 0; i < 8; i++)
    h.context.add(s, a, [{ role: "assistant", content: "证据 " + i + " ".repeat(1000) }]);
  h.apiModel.complete = async () => ({ text: "编造的结论 [unit_nonexistent]", calls: [] });
  const result = await h.context.compact(s, a, { delayMs: 0 });
  assert.equal(result.method, "extractive-with-archive");
  assert.doesNotMatch(a.summary, /编造的结论/);
});
test("startup upgrades shipped tool contracts while retaining historical package versions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-upgrade-"));
  let h = new Harness({ root, speed: 0 });
  t.after(async () => {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const item = h.catalog.library.get("seed-tool-history_search");
  item.tool.parameters = {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  };
  item.version = h.catalog.library.repo.savePackage({ "tool.json": JSON.stringify(item.tool) });
  h.catalog.library.repo.put("items", item.id, item);
  h.catalog.library.repo.put("versions", `${item.id}@${item.version}`, item);
  const previous = item.version;
  await h.close();
  h = new Harness({ root, speed: 0 });
  const current = h.catalog.library.get(item.id);
  assert.notEqual(current.version, previous);
  assert.ok(h.catalog.getTool("history_search").parameters.properties.seq);
  assert.ok(h.catalog.library.package(item.id, previous)["tool.json"]);
});
test("startup upgrades bundled example Skills while retaining their prior package", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-upgrade-"));
  let h = new Harness({ root, speed: 0 });
  t.after(async () => {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const item = h.catalog.library.get("seed-skill-teacher-day-orchestrator"),
    files = h.catalog.library.package(item.id);
  files["SKILL.md"] = files["SKILL.md"].replace(
    "每位成员使用一个独立图片助手",
    "旧版双人图片工作包",
  );
  item.version = h.catalog.library.repo.savePackage(files);
  h.catalog.library.repo.put("items", item.id, item);
  h.catalog.library.repo.put("versions", `${item.id}@${item.version}`, item);
  const previous = item.version;
  await h.close();
  h = new Harness({ root, speed: 0 });
  const current = h.catalog.library.get(item.id);
  assert.notEqual(current.version, previous);
  assert.match(h.catalog.library.package(item.id)["SKILL.md"], /每位成员使用一个独立图片助手/);
  assert.match(h.catalog.library.package(item.id, previous)["SKILL.md"], /旧版双人图片工作包/);
});
