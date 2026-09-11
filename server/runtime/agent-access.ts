import path from "node:path";
import { RuntimeFault } from "./contracts.ts";
import type { AssistantDefinition } from "./agent-definitions.ts";

export interface Material {
  path: string;
  sourceAgentId: string;
  sourcePath?: string;
  artifactId?: string;
  digest: string;
}
export interface Delegation {
  type: string;
  definition: AssistantDefinition;
  mode: "foreground" | "background";
  background: string;
  expectedOutput: string;
  reason: string;
  requirementRevision: number;
  materials: Material[];
  artifactIds: string[];
  inputVersion: number;
}
export interface ScopedAgent {
  id: string;
  parentId: string | null;
  delegation?: Delegation;
  ownedArtifacts?: string[];
}
export function relativePath(value: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value))
    throw new RuntimeFault("PATH_DENIED", "只接受工作目录内的相对路径");
  const result = path.normalize(value);
  if (result === "." || result === ".." || result.startsWith("../"))
    throw new RuntimeFault("PATH_DENIED", "路径超出工作目录");
  return result;
}
export function toolAllowed(a: ScopedAgent, name: string): boolean {
  if (!a.parentId) return true;
  const spec = a.delegation?.definition;
  if (!spec) return name !== "file_write" && !name.startsWith("agent_");
  if (name === "agent_spawn" && !spec.canDelegateTo.length) return false;
  if (name === "file_write" && spec.workspaceMode !== "outputs") return false;
  return spec.tools.includes(name);
}
export function assertTool(a: ScopedAgent, name: string) {
  if (!toolAllowed(a, name)) throw new RuntimeFault("POLICY_DENIED", `此助手不能使用 ${name}`);
}
export function assertSkill(a: ScopedAgent, name: string) {
  if (a.parentId && !a.delegation?.definition.allowedSkills.includes(name))
    throw new RuntimeFault("POLICY_DENIED", `此助手不能加载 Skill ${name}`);
}
export function canRead(a: ScopedAgent, value: string): boolean {
  const file = relativePath(value);
  if (!a.parentId) return !file.startsWith("agents/");
  return (
    !!a.delegation?.materials.some((m) => m.path === file) ||
    (a.delegation?.definition.workspaceMode === "outputs" && file.startsWith("outputs/"))
  );
}
export function assertRead(a: ScopedAgent, value: string) {
  if (!canRead(a, value)) throw new RuntimeFault("PATH_DENIED", "材料没有分配给当前助手");
}
export function assertWrite(a: ScopedAgent, value: string) {
  const file = relativePath(value);
  assertTool(a, "file_write");
  if (/(^|\/)(?:.*\.(?:test|spec)\.[^/]+|\.env(?:\..*)?)$/.test(file) || file.startsWith("agents/"))
    throw new RuntimeFault("POLICY_DENIED", "禁止改写测试、环境配置或其他助手的目录");
  if (
    a.parentId &&
    (!file.startsWith("outputs/") || a.delegation?.materials.some((m) => m.path === file))
  )
    throw new RuntimeFault("POLICY_DENIED", "子助手只能写入自己的 outputs 目录，不能改写输入材料");
}
export function canReadArtifact(a: ScopedAgent, id: string): boolean {
  return (
    !a.parentId || !!a.ownedArtifacts?.includes(id) || !!a.delegation?.artifactIds.includes(id)
  );
}
