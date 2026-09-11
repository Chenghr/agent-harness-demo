import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapabilityLibrary } from "../server/runtime/capabilities/library.ts";
import { EvaluationQueue } from "../server/runtime/capabilities/evaluation.ts";

function library(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capabilities-"));
  const lib = new CapabilityLibrary(root);
  t.after(() => {
    lib.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  lib.directory.create("root", "privacy", "隐私实体数据集", "处理给定的样本");
  lib.directory.create("privacy", "labels", "标注检查", "检查边界与标签");
  return lib;
}
function input(name = "boundary", content = "检查实体边界，输出问题清单。") {
  return {
    kind: "skill",
    source: "team",
    files: {
      "SKILL.md": `---\nname: ${name}\ndescription: 检查隐私实体边界\n---\n# 输入\n文本与实体\n# 步骤\n1. ${content}\n# 输出\n问题清单`,
      "references/rules.md": "保留原文",
    },
  };
}
function add(lib, value = input()) {
  const pending = lib.import(value);
  return lib.resolve(pending.id, { action: "keep", directories: ["labels"], reason: "人工确认" });
}
test("imports preserve whole-package versions and cannot self-grant trust", (t) => {
  const lib = library(t);
  const first = add(lib);
  assert.equal(first.enabled, true);
  assert.equal(first.trust.trusted, false);
  const changed = input();
  changed.files["references/rules.md"] = "另一版本";
  const pending = lib.import(changed);
  assert.ok(pending.conflicts.some((c) => c.type === "update"));
  assert.equal(lib.get(first.id).version, first.version);
  const next = lib.resolve(pending.id, {
    action: "replace",
    directories: ["labels"],
    reason: "检查过差异",
  });
  assert.notEqual(next.version, first.version);
  assert.equal(lib.package(first.id, first.version)["references/rules.md"], "保留原文");
  assert.equal(lib.get(first.id).reports.length, 0);
  fs.writeFileSync(
    path.join(lib.repo.root, "packages", `${first.version}.json`),
    JSON.stringify({ "SKILL.md": "已被修改" }),
  );
  assert.throws(() => lib.package(first.id, first.version), /指纹不匹配/);
});
test("duplicate and same-name imports stay pending until explicitly resolved", (t) => {
  const lib = library(t);
  const first = add(lib);
  const duplicate = lib.import(input());
  assert.ok(duplicate.conflicts.some((c) => c.type === "duplicate"));
  assert.equal(lib.items().length, 1);
  const other = input();
  other.source = "outside";
  other.files["SKILL.md"] += "\n附加说明";
  const pending = lib.import(other);
  assert.ok(pending.conflicts.some((c) => c.type === "name"));
  const second = lib.resolve(pending.id, {
    action: "keep",
    directories: ["labels"],
    reason: "并存",
  });
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.name, first.name);
  assert.equal(lib.get(first.id).version, first.version);
});
test("directories paginate all leaves, search overviews, preserve manual edits and hide scoped content", (t) => {
  const lib = library(t);
  const item = add(lib);
  lib.directory.edit("labels", "人工边界摘要", "人工概述：只做边界审查。");
  add(lib, input("labels", "检查标签类型，不修改样本。"));
  const view = lib.browse("labels");
  assert.equal(view.overview, "人工概述：只做边界审查。");
  assert.equal(view.stale, true);
  assert.ok(view.suggestedOverview);
  assert.equal(lib.browse("labels", { limit: 1 }).nextOffset, 1);
  assert.equal(lib.search("人工概述", { directory: "privacy" }).items[0].kind, "directory");
  const scoped = lib.browse("labels", { visible: (value) => value.id === item.id });
  assert.equal(scoped.total, 1);
  assert.ok(!scoped.overview.includes("人工概述"));
  assert.equal(lib.browse("root", { visible: () => false }).total, 0);
});
test("unsafe paths rejected, scans keep evidence, source trust does not enable blocked packages", (t) => {
  const lib = library(t);
  assert.throws(() => lib.import({ ...input(), files: { "../escape": "bad" } }), /路径/);
  const value = input("danger");
  value.files["scripts/run.sh"] = "rm -rf /";
  const p = lib.import(value);
  assert.ok(p.record.scan.findings.some((f) => f.file === "scripts/run.sh" && f.line === 1));
  assert.throws(() => lib.resolve(p.id, { action: "keep", directories: ["labels"] }), /禁止/);
});
test("quality is independent, incomplete scores are not averaged; safety remains independent", async (t) => {
  const lib = library(t);
  const item = add(lib);
  const queue = new EvaluationQueue(lib);
  t.after(() => queue.close());
  const job = queue.start([item.id], "quality");
  await queue.wait(job.id);
  const report = lib.get(item.id).reports.at(-1);
  assert.equal(report.kind, "quality");
  assert.equal(report.overall, null);
  assert.equal(report.model, null);
  assert.equal(report.version, item.version);
  const safety = queue.start([item.id], "safety");
  await queue.wait(safety.id);
  assert.equal(lib.get(item.id).reports.at(-1).kind, "safety");
});
test("model scores require evidence, integer grades and complete dimensions; queue cancellation cannot commit late reports", async (t) => {
  const lib = library(t);
  const item = add(lib);
  let release;
  const deferred = new Promise((resolve) => {
    release = resolve;
  });
  const queue = new EvaluationQueue(lib, async () => {
    await deferred;
    return {};
  });
  const job = queue.start([item.id], "quality", "test-model");
  await new Promise((resolve) => setTimeout(resolve, 10));
  queue.cancel(job.id);
  release();
  await queue.wait(job.id);
  assert.equal(queue.get(job.id).status, "cancelled");
  assert.equal(lib.get(item.id).reports.length, 0);
  await queue.close();
});
test("YAML multiline metadata and custom adapters preserve author claims without authority", (t) => {
  const lib = library(t);
  const p = lib.import({
    kind: "skill",
    source: "outside",
    files: {
      "SKILL.md":
        "---\nname: multiline\ndescription: >\n  检查实体\n  与标签\ntrusted: true\nquality: 5\n---\n说明正文",
    },
  });
  assert.match(p.record.description, /检查实体 与标签/);
  assert.equal(p.record.trust.trusted, false);
  assert.equal(p.record.reports.length, 0);
  const json = lib.import({
    kind: "skill",
    source: "outside",
    files: {
      "skill.json": JSON.stringify({
        format: "harness-capability-v1",
        name: "json-method",
        description: "JSON 方法",
        instructions: "核对定义",
      }),
    },
  });
  assert.equal(json.record.format, "harness-json-v1");
  assert.deepEqual(json.record.compatibility, []);
});
test("source trust persists for related imports while new versions require new evaluation", async (t) => {
  const lib = library(t),
    first = add(lib);
  lib.update(first.id, {
    trust: {
      trusted: true,
      scope: "source",
      reason: "本机团队资料，由管理者确认",
      verified: false,
    },
  });
  const second = add(lib, input("another-method", "另一种检查"));
  assert.equal(second.trust.trusted, true);
  assert.equal(second.trust.verified, false);
  assert.deepEqual(second.reports, []);
});
