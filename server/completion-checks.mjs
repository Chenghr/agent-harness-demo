import { checkPrivacyDataset } from "./privacy-demo.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { safePath } from "./core.mjs";
import { CART_TEST, BROKEN_CART, SCENARIOS } from "./fixtures.mjs";
import { reviewRequired } from "./runtime/completion-check.ts";

const descriptions = {
  privacy: "合成文本与规则未修改；dataset.json 的样本、标签、码点边界符合本次示例要求。",
  full: "重新运行原有购物车测试，全部通过；测试文件保持原样。检查范围是示例代码的测试结果。",
  security: "示例越界读取与改写测试被拒绝，原始文件保持不变。",
  scale: "至少完成 1005 次示例计算调用，且没有工具失败。",
  manual: "尚未配置适用于本任务的自动成果标准，最终结果需要用户验收。",
};
const check = (name, passed, detail) => ({ name, status: passed ? "passed" : "failed", detail });
function result(checks) {
  const failed = checks.filter((c) => c.status === "failed");
  return {
    verdict: failed.length ? "revise" : "pass",
    summary: failed.length
      ? "成果检查未通过，请处理未通过项目。"
      : "当前任务配置的检查项目全部通过。",
    checks,
  };
}

/** Task-owned criteria and concrete checks stay outside the generic controller. */
export class CompletionChecks {
  constructor(harness, customCheck) {
    this.harness = harness;
    this.customCheck = customCheck;
  }

  configure(s) {
    const preset = SCENARIOS.find((item) => item.id === s.scenario);
    const kind =
      preset?.prompt === s.userRequirements[0] &&
      ["full", "security", "scale", "privacy"].includes(s.scenario)
        ? s.scenario
        : "manual";
    return { kind, description: descriptions[kind], requirementRevision: s.revision };
  }

  version(s, a) {
    const workspace = this.harness.workspace(s, a);
    const hash = createHash("sha256");
    // Hash the actual top-level task files too, so an external edit invalidates an old review.
    if (s.workspaceId && !a.parentId) {
      for (const file of this.harness.workspaces.files(s.workspaceId)) {
        hash.update(file);
        hash.update(fs.readFileSync(safePath(workspace, file)));
      }
    } else if (fs.existsSync(workspace))
      for (const name of fs.readdirSync(workspace).sort()) {
        const file = path.join(workspace, name),
          stat = fs.lstatSync(file);
        hash.update(name);
        if (stat.isFile()) hash.update(fs.readFileSync(safePath(workspace, name)));
        else hash.update(stat.isSymbolicLink() ? "symlink" : "directory");
      }
    return JSON.stringify([
      s.revision,
      s.workspaceRevision,
      s.grantVersion,
      a.model,
      s.acceptance,
      a.delegation?.inputVersion,
      a.outputRevision,
      this.harness.delivery?.state(s).version,
      hash.digest("hex"),
    ]);
  }

  async verify(s, a, text, lease) {
    lease.assertActive();
    if (!text.trim())
      return result([check("最终说明", false, "最终说明为空，请提供成果及其依据。")]);
    if (this.customCheck)
      return this.customCheck({ session: s, agent: a, text, signal: lease.signal });
    if (a.parentId)
      return reviewRequired(
        "后台结果已返回，内容作为待核实资料交给主助手；尚未配置该子任务的自动验收标准。",
      );
    const delivery = this.harness.delivery?.state(s);
    if (delivery?.requirements) {
      const preview = delivery.previews.at(-1);
      if (!preview?.members) return result([check("网站预览", false, "尚未生成包含全部成员的祝福网站预览")]);
      try { this.harness.delivery.assertFresh(s, preview); }
      catch (error) { return result([check("网站预览版本", false, error.message)]); }
      return { verdict: "review", summary: "成员与字数检查通过，请预览画面。网站发布仍需单独批准。", checks: [check("成员和祝福", true, `${preview.members.length} 位成员，已按用户名单与字数要求检查`), { name: "画面与内容质量", status: "unknown", detail: "请用户在预览中确认形象、风格和祝福内容" }] };
    }
    const policy = s.acceptance;
    if (!policy || policy.kind === "manual" || s.revision !== policy.requirementRevision)
      return reviewRequired(
        s.revision !== policy?.requirementRevision
          ? "任务要求已补充或改变，原有检查不能覆盖新要求，请验收当前成果。"
          : descriptions.manual,
      );
    const read = (name) => fs.readFileSync(safePath(s.workspace, name), "utf8");
    if (policy.kind === "privacy") {
      let issues;
      try {
        issues = checkPrivacyDataset(read("source.json"), read("rules.md"), read("dataset.json"));
      } catch (error) {
        issues = [`材料或标注结果无法读取：${error.code ?? "读取失败"}`];
      }
      const artifact = this.harness.artifact(
        s,
        "dataset-check.json",
        JSON.stringify(
          { passed: !issues.length, issues, scope: "仅核对三条合成教学样本，不代表通用标注质量" },
          null,
          2,
        ),
      );
      return result([
        check(
          "本次示例标注检查",
          !issues.length,
          issues.length ? issues.join("；") : `原文、实体与边界检查通过。报告 ${artifact.id}`,
        ),
      ]);
    }
    if (policy.kind === "full") {
      const unchanged = read("cart.test.mjs") === CART_TEST;
      const checks = [
        check(
          "原有测试未改动",
          unchanged,
          unchanged ? "测试文件与初始内容一致。" : "测试文件已改变，不能通过修改测试降低标准。",
        ),
      ];
      if (!unchanged) return result(checks);
      const run = await this.harness.toolSlots.run(() => {
        lease.assertActive();
        return this.harness.processes.run({
          sessionId: s.id,
          agentId: a.id,
          cwd: s.workspace,
          args: ["--test", "--test-reporter=tap", "cart.test.mjs"],
          signal: lease.signal,
          timeout: 10000,
        });
      }, lease.signal);
      lease.assertActive();
      const artifact = this.harness.artifact(s, "completion-tests.txt", run.output);
      const expected = (CART_TEST.match(/^test\(/gm) ?? []).length;
      const completed =
        new RegExp(`^# tests ${expected}$`, "m").test(run.output) &&
        new RegExp(`^# pass ${expected}$`, "m").test(run.output) &&
        /^# fail 0$/m.test(run.output) &&
        /^# skipped 0$/m.test(run.output);
      checks.push(
        check(
          "当前实现通过原有测试",
          run.exitCode === 0 && completed && read("cart.test.mjs") === CART_TEST,
          `本次重新执行 ${expected} 项原有测试，退出码 ${run.exitCode}，测试是否全部执行并通过：${completed}；结果记录 ${artifact.id}。\n${run.output.slice(-1600)}`,
        ),
      );
      return result(checks);
    }
    if (policy.kind === "security") {
      const events = this.harness.store.events(s.id, 0, Infinity);
      return result([
        check(
          "越界读取被拒绝",
          events.some((e) => e.type === "tool.failed" && e.data.code === "PATH_DENIED"),
          "查看本任务的 PATH_DENIED 记录。",
        ),
        check(
          "改写测试被拒绝",
          events.some((e) => e.type === "tool.failed" && e.data.code === "POLICY_DENIED"),
          "查看本任务的 POLICY_DENIED 记录。",
        ),
        check(
          "示例文件保持不变",
          read("cart.mjs") === BROKEN_CART && read("cart.test.mjs") === CART_TEST,
          "比较实际文件与初始示例内容。",
        ),
      ]);
    }
    if (policy.kind === "scale")
      return result([
        check(
          "完成示例计算次数",
          s.stats.fixtureCalls >= 1005,
          `已记录 ${s.stats.fixtureCalls} 次成功示例计算。`,
        ),
        check("没有工具失败", s.stats.failed === 0, `失败次数 ${s.stats.failed}。`),
      ]);
    return reviewRequired("找不到该任务的成果检查规则，请人工验收。");
  }
}
