import { randomUUID } from "node:crypto";
import type { Capability, Evidence, Files, Grade, Report } from "./types.ts";
import { fault } from "./types.ts";
import { CapabilityLibrary } from "./library.ts";

export const qualityDimensions = [
  "用途清楚",
  "步骤可执行",
  "输入输出明确",
  "内容一致",
  "资源与依赖完整",
  "内容组织合理",
];
export const toolDimensions = [
  "用途清楚",
  "参数结构明确",
  "输入输出明确",
  "示例与说明一致",
  "依赖与错误表达",
  "内容组织合理",
];
export const qualityRubric =
  "1 严重不足；2 需要较多修改；3 基本合格；4 良好；5 优秀。按每个维度原文证据评分，不因未附脚本扣分。资料未读不得打分；真正不适用需说明理由。关键引用缺失属于缺陷。完整综合分由程序计算，所有适用维度等权平均。";
export type ModelReviewer = (args: {
  kind: Report["kind"];
  model: string;
  item: Capability;
  files: Files;
  signal: AbortSignal;
}) => Promise<unknown>;
interface Job {
  id: string;
  kind: Report["kind"];
  model: string | null;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  total: number;
  completed: number;
  items: { id: string; version: string }[];
  errors: string[];
  createdAt: string;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fault("评估模型返回格式不正确");
  return value as Record<string, unknown>;
}
function evidence(value: unknown, files: Files): Evidence[] {
  if (!Array.isArray(value)) fault("评估缺少证据");
  return value.map((v) => {
    const e = object(v),
      file = String(e.file),
      line = Number(e.line),
      quote = String(e.quote ?? "");
    if (
      !Number.isInteger(line) ||
      line < 1 ||
      !quote ||
      !files[file]
        ?.split("\n")
        .slice(line - 1)
        .join("\n")
        .startsWith(quote)
    )
      fault("模型证据无法在原文指定位置核实");
    return { file, line, quote };
  });
}
export function qualityReport(
  item: Capability,
  files: Files,
  raw?: unknown,
): Pick<Report, "grades" | "overall" | "gaps" | "critical"> {
  const dimensions = item.kind === "tool" ? toolDimensions : qualityDimensions;
  let grades: Grade[];
  if (raw !== undefined) {
    const result = object(raw);
    if (!Array.isArray(result.grades) || result.grades.length !== dimensions.length)
      fault("质量评估需要覆盖全部维度");
    grades = result.grades.map((value) => {
      const g = object(value),
        dimension = String(g.dimension),
        status = String(g.status) as Grade["status"];
      if (
        !dimensions.includes(dimension) ||
        !["scored", "uncovered", "not-applicable"].includes(status) ||
        !String(g.reason ?? "").trim()
      )
        fault("质量评估维度或说明不合法");
      const score = status === "scored" ? Number(g.score) : null;
      if (
        score !== null &&
        (typeof g.score !== "number" || !Number.isInteger(score) || score < 1 || score > 5)
      )
        fault("质量分必须为 1—5 的整数");
      const proof = evidence(g.evidence ?? [], files);
      if (status !== "uncovered" && !proof.length) fault("打分或不适用判断需要原文证据");
      return {
        dimension,
        status,
        score,
        evidence: proof,
        reason: String(g.reason),
        suggestion: String(g.suggestion ?? ""),
      };
    });
    if (new Set(grades.map((g) => g.dimension)).size !== dimensions.length) fault("评分维度重复");
  } else {
    grades = dimensions.map((dimension) => ({
      dimension,
      score: null,
      status: "uncovered",
      evidence: [],
      reason: "尚未进行模型阅读；规则扫描不能代替此项判断",
      suggestion: "选择已配置的真实模型发起独立评估",
    }));
  }
  const scored = grades.filter((g) => g.status === "scored");
  return {
    grades,
    overall:
      grades.some((g) => g.status === "uncovered") || !scored.length
        ? null
        : Number((scored.reduce((n, g) => n + g.score!, 0) / scored.length).toFixed(1)),
    gaps: grades.filter((g) => g.status === "uncovered").map((g) => g.dimension),
    critical: item.scan.findings
      .filter((f) => ["missing-reference", "root-delete"].includes(f.rule))
      .map((f) => `${f.file}:${f.line} ${f.reason}`),
  };
}
export function safetyReport(
  item: Capability,
  files: Files,
  raw?: unknown,
): Pick<Report, "risk" | "findings" | "sections" | "gaps" | "critical"> {
  const blocked = item.scan.findings.some((f) => f.severity === "block");
  const result: Pick<Report, "risk" | "findings" | "sections" | "gaps" | "critical"> = {
    risk: blocked ? "high" : "insufficient",
    findings: item.scan.findings,
    gaps: ["尚未完成语义检查", ...item.compatibility],
    critical: item.scan.findings.filter((f) => f.severity === "block").map((f) => f.reason),
    sections: [],
  };
  if (raw !== undefined) {
    const r = object(raw),
      risk = String(r.risk) as Report["risk"];
    if (
      !["low", "medium", "high", "insufficient"].includes(String(risk)) ||
      !Array.isArray(r.sections) ||
      r.sections.length !== 5 ||
      !Array.isArray(r.gaps)
    )
      fault("安全报告需要五项判断、风险等级及覆盖缺口");
    result.sections = r.sections.map((value) => {
      const section = object(value);
      const proof = evidence(section.evidence, files);
      if (!proof.length) fault("安全判断缺少原文证据");
      return {
        title: String(section.title),
        judgment: String(section.judgment),
        evidence: proof,
        suggestion: String(section.suggestion ?? ""),
      };
    });
    result.gaps = [...r.gaps.map(String), ...item.compatibility];
    result.risk = blocked || risk === "high" ? "high" : result.gaps.length ? "insufficient" : risk;
  }
  return result;
}
/** A separate queue: no business conversation, no script tools, no permission mutations. */
export class EvaluationQueue {
  library: CapabilityLibrary;
  reviewer?: ModelReviewer;
  running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  tail: Promise<void> = Promise.resolve();
  constructor(library: CapabilityLibrary, reviewer?: ModelReviewer) {
    this.library = library;
    this.reviewer = reviewer;
    for (const job of this.list())
      if (job.status === "queued" || job.status === "running")
        this.save({
          ...job,
          status: "failed",
          errors: [...job.errors, "应用重启，原评估未完成，请重新发起"],
        });
  }
  save(job: Job) {
    this.library.repo.put("jobs", job.id, job);
  }
  list(): Job[] {
    return this.library.repo.list<Job>("jobs");
  }
  get(id: string): Job {
    return this.library.repo.get<Job>("jobs", id) ?? fault("评估任务不存在");
  }
  start(ids: string[], kind: Report["kind"], model?: string) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 200 ||
      !["quality", "safety"].includes(kind)
    )
      fault("请选择 1—200 项和评估类型");
    if (model && !this.reviewer) fault("尚未配置评估模型");
    const snapshots = [...new Set(ids)].map((id) => {
      const item = this.library.get(id);
      return { item, files: this.library.package(id) };
    });
    const job: Job = {
      id: randomUUID(),
      kind,
      model: model ?? null,
      status: "queued",
      total: snapshots.length,
      completed: 0,
      items: snapshots.map((s) => ({ id: s.item.id, version: s.item.version })),
      errors: [],
      createdAt: new Date().toISOString(),
    };
    this.save(job);
    const controller = new AbortController();
    const promise = this.tail
      .then(async () => {
        if (controller.signal.aborted) return;
        job.status = "running";
        this.save(job);
        for (const { item, files } of snapshots) {
          if (controller.signal.aborted) break;
          try {
            const raw = model
              ? await this.reviewer!({ kind, model, item, files, signal: controller.signal })
              : undefined;
            if (controller.signal.aborted) break;
            const analysis =
              kind === "quality" ? qualityReport(item, files, raw) : safetyReport(item, files, raw);
            this.library.addReport(item.id, {
              id: randomUUID(),
              kind,
              version: item.version,
              date: new Date().toISOString(),
              rules: `${kind}-v1`,
              model: model ?? null,
              coverage: Object.keys(files),
              ...analysis,
            });
          } catch (error) {
            if (!controller.signal.aborted)
              job.errors.push(
                `${item.name}: ${error instanceof Error ? error.message : "评估失败"}`,
              );
          }
          if (!controller.signal.aborted) {
            job.completed++;
            this.save(job);
          }
        }
        job.status = controller.signal.aborted
          ? "cancelled"
          : job.errors.length
            ? "failed"
            : "completed";
        this.save(job);
      })
      .finally(() => {
        this.running.delete(job.id);
      });
    this.tail = promise.catch(() => {});
    this.running.set(job.id, { controller, promise });
    return this.get(job.id);
  }
  cancel(id: string) {
    const job = this.get(id);
    this.running.get(id)?.controller.abort();
    if (job.status === "queued" || job.status === "running") {
      job.status = "cancelled";
      this.save(job);
    }
    return job;
  }
  async wait(id: string) {
    await this.running.get(id)?.promise;
    return this.get(id);
  }
  async close() {
    for (const [id] of this.running) this.cancel(id);
    await this.tail;
  }
}
