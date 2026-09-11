import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Harness } from "../server/harness.mjs";
import { delay } from "../server/core.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-scale-"));
const h = new Harness({ root, speed: 0 });
const start = Date.now();
const initial = h.create({ scenario: "scale" });
const s = h.get(initial.id);
try {
  while (!["completed", "failed", "needs_review"].includes(s.status)) {
    if (Date.now() - start > 60000) throw new Error("Scale run timed out");
    await delay(20);
  }
  const completed = h.store.events(s.id, 0, Infinity).filter((e) => e.type === "tool.succeeded");
  const fixtureCalls = completed.filter(
    (e) => e.data.result?.simulated === true && e.data.result?.tool,
  ).length;
  assert.equal(s.status, "completed");
  assert.equal(fixtureCalls, 1005);
  assert.equal(h.processes.list().length, 0);
  assert.equal(s.stats.failed, 0);
  const longRunMs = Date.now() - start;
  const toolsSession = h.get(
    h.create({ autoStart: false, prompt: "目录容量验证：逐项加载、调用和卸载" }).id,
  );
  const skillsSession = h.get(
    h.create({ autoStart: false, prompt: "Skill 容量验证：逐项加载和卸载" }).id,
  );
  let distinctTools = 0,
    distinctSkills = 0;
  for (const tool of h.catalog.tools.values()) {
    if (!tool.simulated) continue;
    await h.invoke(toolsSession, toolsSession.agents.main, "tool_load", { name: tool.name });
    await h.invoke(toolsSession, toolsSession.agents.main, tool.name, { values: [2, 4, 6] });
    await h.invoke(toolsSession, toolsSession.agents.main, "tool_unload", { name: tool.name });
    distinctTools++;
    if (distinctTools % 100 === 0) await delay(0);
  }
  for (const name of h.catalog.skills.keys()) {
    await h.invoke(skillsSession, skillsSession.agents.main, "skill_load", { name });
    await h.invoke(skillsSession, skillsSession.agents.main, "skill_unload", { name });
    distinctSkills++;
    if (distinctSkills % 100 === 0) await delay(0);
  }
  assert.equal(distinctTools, 1200);
  assert.equal(distinctSkills, h.catalog.skills.size);
  assert.ok(distinctSkills >= 1000);
  const report = {
    createdAt: new Date().toISOString(),
    mode: "deterministic-model-and-fixture-data / real harness dispatch",
    node: process.version,
    durationMs: Date.now() - start,
    catalog: h.catalog.counts(),
    fixtureCalls,
    totalCalls: s.stats.toolCalls,
    failed: s.stats.failed,
    compactions: s.agents.main.compactions,
    retainedActions: s.actions.length,
    liveResources: h.processes.list().length,
    context: h.snapshot(s.id).agents.main.context.tokens,
    limitations: ["不代表 1000 个真实外部服务", "不代表千级并发", "不代表真实模型长程任务质量"],
  };
  Object.assign(report, {
    longRunMs,
    distinctToolsLoadedExecutedUnloaded: distinctTools,
    distinctSkillsLoadedUnloaded: distinctSkills,
    catalogProbeMode: "sequential runtime broker calls, without model inference",
    catalogProbeErrors: toolsSession.stats.failed + skillsSession.stats.failed,
  });
  assert.equal(report.catalogProbeErrors, 0);
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/scale.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await h.close();
  fs.rmSync(root, { recursive: true, force: true });
}
