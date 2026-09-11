import { parseDocument } from "yaml";
import type { Capability, ImportInput } from "./types.ts";
import { fault } from "./types.ts";
import { checkedFiles, fingerprint } from "./repository.ts";

function mapping(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fault("文件头或配置必须是对象");
  return value as Record<string, unknown>;
}
function yaml(text: string): Record<string, unknown> {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) fault(`YAML 无法解析：${doc.errors[0]?.message}`);
  return mapping(doc.toJS({ maxAliasCount: 20 }));
}
export function parseImport(input: ImportInput): {
  record: Capability;
  files: ImportInput["files"];
} {
  if (
    !["skill", "tool"].includes(input.kind) ||
    typeof input.source !== "string" ||
    !input.source.trim()
  )
    fault("需要能力类型和实际导入来源");
  const files = checkedFiles(input.files);
  const entry =
    input.entry ??
    (files["SKILL.md"] !== undefined
      ? "SKILL.md"
      : Object.keys(files).find((n) => /\.(md|json|ya?ml)$/i.test(n)));
  if (!entry || files[entry] === undefined) fault("找不到入口文件");
  const content = files[entry]!;
  let claims: Record<string, unknown> = {},
    format = "markdown";
  if (/\.json$/i.test(entry)) {
    claims = mapping(JSON.parse(content));
    format = "harness-json-v1";
  } else if (/\.ya?ml$/i.test(entry)) {
    claims = yaml(content);
    format = "harness-yaml-v1";
  } else if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) fault("SKILL.md 的 YAML 文件头没有结束");
    claims = yaml(match[1]!);
    format = "agent-skills";
  }
  const originalName = String(input.name ?? claims.name ?? entry.replace(/\.[^.]+$/, ""));
  if (!/^[\p{L}\p{N}_.-]{1,100}$/u.test(originalName))
    fault("名称只能包含文字、数字、点、横线和下划线");
  const compatibility: string[] = [];
  if (format.includes("harness-") && claims.format !== "harness-capability-v1")
    compatibility.push("自定义 JSON/YAML 仅支持 harness-capability-v1；专有运行语义未适配");
  for (const k of ["hooks", "lifecycle", "command"])
    if (claims[k]) compatibility.push(`${k} 未自动转换为可执行入口`);
  const dependencyValue = claims.dependencies;
  const dependencies = Array.isArray(dependencyValue)
    ? dependencyValue.map((v) =>
        typeof v === "string"
          ? { name: v, required: true, origin: "author" as const }
          : {
              name: String(mapping(v).name),
              required: mapping(v).required !== false,
              origin: "author" as const,
            },
      )
    : [];
  const version = fingerprint(files),
    id = `cap-${fingerprint([input.kind, input.source, originalName]).slice(0, 20)}`;
  const record: Capability = {
    id,
    name: originalName,
    originalName,
    title: String(claims.title ?? originalName),
    description: String(
      input.description ??
        claims.description ??
        content
          .replace(/^---[\s\S]*?---\s*/, "")
          .split("\n")
          .find((l) => l.trim() && !l.startsWith("#")) ??
        originalName,
    ),
    kind: input.kind,
    source: input.source,
    sources: [input.source],
    version,
    authorVersion: claims.version ? String(claims.version) : undefined,
    entry,
    format,
    claims,
    enabled: false,
    directories: [],
    simulated: false,
    scan: { findings: [], coverage: [], semantic: "not-run", rules: "scan-v1" },
    permissions: [],
    dependencies,
    compatibility,
    trust: { trusted: false, verified: false },
    reports: [],
  };
  if (input.kind === "tool") {
    record.tool = mapping(claims.tool ?? claims);
    // Imported executable declarations are descriptive data, never executable bindings.
    record.compatibility.push("尚未绑定本机可信执行适配器；只能审查，不能调用");
  }
  return { record, files };
}
