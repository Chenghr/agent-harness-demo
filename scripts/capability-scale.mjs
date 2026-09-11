import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "../server/harness.mjs";
import { estimateTokens } from "../server/context.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-capability-scale-"));
const started = performance.now();
const h = new Harness({ root, speed: 0, env: {} });
try {
  const lib = h.catalog.library;
  const setupMs = performance.now() - started;
  const rootStart = performance.now();
  const rootView = lib.browse("root");
  const rootMs = performance.now() - rootStart;
  const queryStart = performance.now();
  const search = lib.search("analytics latency mean", { kind: "skill" });
  const searchMs = performance.now() - queryStart;
  const snapshot = h.create({ scenario: "custom", prompt: "验证千级能力加载", autoStart: false }),
    s = h.get(snapshot.id),
    a = s.agents.main;
  const skills = lib
    .items()
    .filter((i) => i.kind === "skill" && i.simulated)
    .slice(0, 1001);
  const loadStart = performance.now();
  let loaded = 0;
  for (const item of skills) {
    h.capabilityLoader.load(s, a, "skill", item.name);
    h.unload(s, a, "skill", item.name);
    loaded++;
  }
  const loadMs = performance.now() - loadStart;
  console.log(
    JSON.stringify(
      {
        counts: h.catalog.counts(),
        setupMs: Math.round(setupMs),
        rootEntries: rootView.total,
        rootTokens: estimateTokens(JSON.stringify(rootView)),
        rootReadMs: Number(rootMs.toFixed(2)),
        searchMatches: search.total,
        searchMs: Number(searchMs.toFixed(2)),
        actualSkillLoads: loaded,
        loadAndUnloadMs: Math.round(loadMs),
        activeSkillsAfter: a.loadedSkills.length,
        simulatedContent: true,
        meaning: "测量真实目录与加载机制；方法内容为教学生成样本，不代表 1001 种方法的业务质量",
      },
      null,
      2,
    ),
  );
} finally {
  await h.close();
  fs.rmSync(root, { recursive: true, force: true });
}
