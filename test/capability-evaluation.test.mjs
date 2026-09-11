import test from "node:test";
import assert from "node:assert/strict";
import {
  qualityReport,
  safetyReport,
  qualityDimensions,
} from "../server/runtime/capabilities/evaluation.ts";
import { managementReviewer } from "../server/capability-reviewer.mjs";
const item = {
  name: "evaluate-test",
  kind: "skill",
  claims: {},
  dependencies: [],
  compatibility: [],
  scan: { findings: [] },
};
const files = { "SKILL.md": "明确的输入和输出\n检查步骤" };
function grades() {
  return qualityDimensions.map((dimension, index) => ({
    dimension,
    status: "scored",
    score: (index % 5) + 1,
    evidence: [{ file: "SKILL.md", line: 1, quote: "明确的输入和输出" }],
    reason: "测试依据",
    suggestion: "测试建议",
  }));
}
test("quality averages only complete integer dimensions with verifiable evidence", () => {
  const result = qualityReport(item, files, { grades: grades() });
  assert.equal(result.overall, 2.7);
  for (const invalid of [0, 6, 1.5, "5"]) {
    const value = grades();
    value[0].score = invalid;
    assert.throws(() => qualityReport(item, files, { grades: value }));
  }
  const missing = grades();
  missing[0].status = "uncovered";
  missing[0].score = null;
  assert.equal(qualityReport(item, files, { grades: missing }).overall, null);
  const invented = grades();
  invented[0].evidence[0].quote = "不存在的原文";
  assert.throws(() => qualityReport(item, files, { grades: invented }));
});
test("a known severe safety finding cannot be averaged away by model opinion", () => {
  const unsafe = {
    ...item,
    scan: { findings: [{ severity: "block", reason: "删除根目录", file: "script.sh", line: 1 }] },
  };
  const model = {
    risk: "low",
    gaps: [],
    sections: Array.from({ length: 5 }, (_, i) => ({
      title: String(i),
      judgment: "测试判断",
      evidence: [{ file: "SKILL.md", line: 1, quote: "明确的输入和输出" }],
      suggestion: "测试建议",
    })),
  };
  assert.equal(safetyReport(unsafe, files, model).risk, "high");
  model.gaps.push("外部实现未提供");
  assert.equal(safetyReport(item, files, model).risk, "insufficient");
});
test("long evaluation reads every fragment without borrowing business context or claiming a complete score", async () => {
  const inputs = [];
  const h = {
    models: { get: () => ({ contextWindow: 6000, maxOutput: 1500, protocol: "responses" }) },
    apiModel: {
      async complete(input) {
        inputs.push(input);
        return {
          text: JSON.stringify({
            grades: qualityDimensions.map((dimension) => ({
              dimension,
              status: "uncovered",
              score: null,
              evidence: [],
              reason: "片段不支持全文判断",
              suggestion: "核实跨段要求",
            })),
          }),
          calls: [],
        };
      },
    },
    sessions: new Map([["private", "不得进入评估"]]),
  };
  const longFiles = {
    "SKILL.md": Array.from(
      { length: 700 },
      (_, i) => `第 ${i} 行：核对定义，保留原文，输出带依据的问题清单。`,
    ).join("\n"),
  };
  const raw = await managementReviewer(h)({
    kind: "quality",
    model: "api-primary",
    item,
    files: longFiles,
    signal: new AbortController().signal,
  });
  assert.ok(inputs.length > 1);
  assert.ok(inputs.every((i) => i.input.tools.length === 0));
  assert.ok(inputs.every((i) => !JSON.stringify(i).includes("不得进入评估")));
  assert.equal(qualityReport(item, longFiles, raw).overall, null);
  const reconstructed = inputs
    .map((i) => JSON.parse(i.input.messages[1].content).files["SKILL.md"])
    .join("\n");
  assert.equal(reconstructed, longFiles["SKILL.md"]);
});
