import type { CompletionCheck, CompletionReport } from "./contracts.ts";

export function reviewRequired(reason: string): CompletionReport {
  return { verdict: "review", summary: reason, checks: [{ name: "结果检查", status: "unknown", detail: reason }] };
}

/** Never infer success from an empty/malformed report or from the checker's verdict alone. */
export function normalizeReport(value: unknown): CompletionReport {
  if (typeof value !== "object" || value === null || !("verdict" in value)
    || !["pass", "revise", "review"].includes(String(value.verdict))
    || !("summary" in value) || typeof value.summary !== "string" || !value.summary.trim()
    || !("checks" in value) || !Array.isArray(value.checks) || !value.checks.length || value.checks.length > 40)
    return reviewRequired("检查器没有返回有效的逐项结果，需要验收。");
  const checks: CompletionCheck[] = [];
  for (const check of value.checks as unknown[]) {
    if (typeof check !== "object" || check === null
      || !("name" in check) || typeof check.name !== "string" || !check.name.trim()
      || !("status" in check) || !["passed", "failed", "unknown"].includes(String(check.status))
      || !("detail" in check) || typeof check.detail !== "string" || !check.detail.trim())
      return reviewRequired("检查器返回的项目不完整，需要验收。");
    checks.push({ name: check.name.slice(0, 200), status: check.status as CompletionCheck["status"], detail: check.detail.slice(0, 2000) });
  }
  const verdict = checks.some((c) => c.status === "failed") ? "revise"
    : checks.some((c) => c.status === "unknown") ? "review" : value.verdict as CompletionReport["verdict"];
  return { verdict, summary: value.summary.slice(0, 3000), checks };
}

export function repairFeedback(report: CompletionReport): string {
  return `[成果检查未通过，请根据以下证据补充工作后重新提交最终回答。检查标准和权限不会因此改变。]\n${report.summary}\n`
    + report.checks.map((c) => `${c.name}：${c.status}；${c.detail}`).join("\n");
}
