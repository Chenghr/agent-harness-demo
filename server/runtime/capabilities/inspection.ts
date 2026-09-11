import type { Capability, Files, Conflict, Finding } from "./types.ts";

const rules = [
  {
    id: "personal-photos", pattern: /~\/(?:Photos|Pictures)|私人相册|组员真人脸|人脸照片/i,
    severity: "review" as const,
    reason: "涉及私人相册或真人脸参考，需要核实是否为禁止示例；运行时不会因此获得读取权限",
    suggestion: "使用文字描述的虚构形象，不读取相册或提交真人脸参考",
  },
  {
    id: "root-delete",
    pattern: /\brm\s+-[rfRF]+\s+\/(?:\s|$)/,
    severity: "block" as const,
    reason: "脚本尝试删除文件系统根目录",
    suggestion: "移除该命令并重新导入",
  },
  {
    id: "escape",
    pattern: /(?:\.\.\/){2,}/,
    severity: "review" as const,
    reason: "出现越出文件包的路径，需要核实是否仅为反例",
    suggestion: "确认实际读取范围；运行仍限制在分配目录",
  },
  {
    id: "override",
    pattern:
      /忽略(?:所有|用户|系统).{0,8}(?:限制|指令|授权)|ignore (?:all|previous|system) instructions/i,
    severity: "review" as const,
    reason: "可能要求绕过约束，也可能是反例",
    suggestion: "核实上下文，不按被扫描指令执行",
  },
  {
    id: "network",
    pattern: /https?:\/\/[^\s)"'<>]+|\b(?:curl|wget|fetch)\b/,
    severity: "review" as const,
    reason: "包含网络目标或访问线索，需区分文档链接与数据发送",
    suggestion: "确认目标、传输内容和必要性",
  },
  {
    id: "execute",
    pattern: /\b(?:exec|spawn|eval|subprocess)\s*\(/,
    severity: "review" as const,
    reason: "包含代码或命令执行入口",
    suggestion: "核对执行内容、参数与工作目录",
  },
];
export function inspect(record: Capability, files: Files): Capability["scan"] {
  const findings: Finding[] = [];
  for (const [file, content] of Object.entries(files))
    content.split("\n").forEach((text, index) => {
      for (const rule of rules)
        if (rule.pattern.test(text))
          findings.push({
            rule: rule.id,
            file,
            line: index + 1,
            evidence: text.slice(0, 500),
            severity:
              rule.id === "root-delete" && !/\.(sh|py|js|mjs|ts)$/.test(file)
                ? "review"
                : rule.severity,
            reason: rule.reason,
            suggestion: rule.suggestion,
            origin: "rule",
          });
      for (const match of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = match[1]!;
        if (/^(https?:|mailto:)/.test(target)) continue;
        const base = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
        if (!(base + target in files))
          findings.push({
            rule: "missing-reference",
            file,
            line: index + 1,
            evidence: text,
            severity: "review",
            reason: `引用缺失或未适配：${target}`,
            suggestion: "补齐资料或修正引用",
            origin: "rule",
          });
      }
    });
  record.permissions = [];
  const declared = record.claims.permissions ?? record.claims["allowed-tools"];
  if (declared)
    record.permissions.push({
      operation: "作者声明",
      target: JSON.stringify(declared),
      origin: "author",
      evidence: record.entry,
    });
  for (const f of findings.filter((f) =>
    ["network", "execute", "root-delete", "escape", "personal-photos"].includes(f.rule),
  ))
    record.permissions.push({
      operation: f.rule,
      target: f.evidence,
      origin: "analysis",
      evidence: `${f.file}:${f.line}`,
    });
  return { findings, coverage: Object.keys(files), semantic: "not-run", rules: "scan-v1" };
}
export function conflicts(record: Capability, items: Capability[]): Conflict[] {
  const results: Conflict[] = [];
  for (const other of items) {
    if (other.kind !== record.kind) continue;
    let type: Conflict["type"] | undefined;
    if (other.version === record.version) type = "duplicate";
    else if (other.id === record.id) type = "update";
    else if (other.originalName === record.originalName) type = "name";
    else if (other.description === record.description) type = "similar";
    if (type)
      results.push({
        type,
        otherId: other.id,
        otherVersion: other.version,
        evidence: [other.description, record.description],
        suggestion: {
          duplicate: "跳过，或补记来源",
          update: "保留旧版，审查后启用新版",
          name: "按来源区分，保留两份",
          similar: "功能相近不等于冲突；确认并存关系",
          contradiction: "保持旧项，核实矛盾",
        }[type],
        confirmed: false,
      });
  }
  const grams = (text: string) =>
    new Set(text.toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9fff]{2}/g) ?? []);
  const tokens = grams(`${record.title} ${record.description}`);
  const nearby = items
    .filter((other) => other.kind === record.kind && !results.some((r) => r.otherId === other.id))
    .map((other) => {
      const theirs = grams(`${other.title} ${other.description}`);
      const shared = [...tokens].filter((t) => theirs.has(t)).length;
      return { other, score: shared / Math.max(1, Math.min(tokens.size, theirs.size)) };
    })
    .filter((x) => x.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  for (const { other } of nearby)
    results.push({
      type: "similar",
      otherId: other.id,
      otherVersion: other.version,
      evidence: [record.description, other.description],
      suggestion: "用途词有重合；仅作为比较候选，请确认是备选、互补还是误报",
      confirmed: false,
    });
  return results;
}
