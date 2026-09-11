import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { RuntimeFault } from "./contracts.ts";

export interface AssistantDefinition {
  name: string;
  description: string;
  instructions: string;
  version: string;
  tools: string[];
  allowedSkills: string[];
  skills: string[];
  model: string;
  allowedModels: string[];
  permissionMode: "default" | "dontAsk";
  workspaceMode: "read" | "outputs";
  canDelegateTo: string[];
  maxTurns: number;
  maxCalls: number;
  timeoutMs: number;
}
type CatalogNames = { tools: string[]; skills: string[]; models: string[] };
const fail = (message: string): never => {
  throw new RuntimeFault("AGENT_CONFIG", message);
};
function words(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0))
    fail(`${field} 必须是名称数组`);
  return [...new Set(value as string[])];
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} 不能为空`);
  return (value as string).trim();
}
function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${field} 必须是正整数`);
  return value as number;
}
function resolve(value: unknown, field: string, available: string[]): string[] {
  const names = words(value, field);
  for (const name of names)
    if (name !== "@catalog" && !available.includes(name)) fail(`${field} 中的 ${name} 不存在`);
  if (names.includes("@catalog")) return [...available];
  return names;
}

/** Configuration is read only from the application's directory, never a task workspace. */
export class AgentDefinitionRegistry {
  private directory: string;
  private readonly definitions = new Map<string, AssistantDefinition>();
  constructor(directory: string, catalog: CatalogNames) {
    this.directory = directory;
    for (const file of fs
      .readdirSync(directory)
      .filter((f) => f.endsWith(".md"))
      .sort()) {
      const source = fs.readFileSync(path.join(directory, file), "utf8");
      // JSON frontmatter is an intentionally small, unambiguous subset of YAML.
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
      if (!match) fail(`${file} 需要 JSON 文件头与工作说明`);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(match![1]!) as Record<string, unknown>;
      } catch {
        fail(`${file} 的 JSON 配置无效`);
      }
      if (!data! || Array.isArray(data) || typeof data !== "object")
        fail(`${file} 的配置必须是对象`);
      const fields = [
        "name",
        "description",
        "tools",
        "disallowedTools",
        "skills",
        "allowedSkills",
        "model",
        "allowedModels",
        "permissionMode",
        "workspaceMode",
        "canDelegateTo",
        "maxTurns",
        "maxCalls",
        "timeoutMs",
      ];
      for (const key of Object.keys(data!))
        if (!fields.includes(key)) fail(`${file} 含未知配置 ${key}`);
      const name = text(data!.name, "name");
      if (!/^[a-z][a-z0-9-]*$/.test(name) || this.definitions.has(name))
        fail(`助手名称无效或重复：${name}`);
      const denied = words(data!.disallowedTools ?? [], "disallowedTools");
      for (const tool of denied)
        if (!catalog.tools.includes(tool)) fail(`禁止的工具不存在：${tool}`);
      const tools = resolve(data!.tools, "tools", catalog.tools).filter((n) => !denied.includes(n));
      const allowedSkills = resolve(data!.allowedSkills ?? [], "allowedSkills", catalog.skills);
      const skills = words(data!.skills ?? [], "skills");
      if (skills.length > 8) fail(`${name} 的预加载 Skill 超过 8 个活跃上限`);
      if (skills.some((n) => !allowedSkills.includes(n)))
        fail(`${name} 的预加载 Skill 超出允许范围`);
      const allowedModels = resolve(data!.allowedModels, "allowedModels", catalog.models);
      const model = text(data!.model ?? "inherit", "model");
      if (model !== "inherit" && !allowedModels.includes(model)) fail(`${name} 的默认模型不被允许`);
      if (!["default", "dontAsk"].includes(String(data!.permissionMode)))
        fail(`${name} 的审批方式无效`);
      if (!["read", "outputs"].includes(String(data!.workspaceMode)))
        fail(`${name} 的工作目录方式无效`);
      this.definitions.set(name, {
        name,
        description: text(data!.description, "description"),
        instructions: text(match![2], "工作说明"),
        version: createHash("sha256").update(source).digest("hex"),
        tools,
        allowedSkills,
        skills,
        model,
        allowedModels,
        permissionMode: data!.permissionMode as AssistantDefinition["permissionMode"],
        workspaceMode: data!.workspaceMode as AssistantDefinition["workspaceMode"],
        canDelegateTo: words(data!.canDelegateTo ?? [], "canDelegateTo"),
        maxTurns: count(data!.maxTurns, "maxTurns"),
        maxCalls: count(data!.maxCalls, "maxCalls"),
        timeoutMs: count(data!.timeoutMs, "timeoutMs"),
      });
    }
    if (!this.definitions.has("general")) fail("需要配置默认通用助手 general");
    for (const d of this.definitions.values())
      for (const name of d.canDelegateTo)
        if (!this.definitions.has(name)) fail(`${d.name} 不能委派不存在的助手 ${name}`);
  }
  updateCatalog(catalog: CatalogNames) {
    const next = new AgentDefinitionRegistry(this.directory, catalog);
    this.definitions.clear();
    for (const [name, definition] of next.definitions) this.definitions.set(name, definition);
  }
  get(name = "general"): AssistantDefinition {
    const definition = this.definitions.get(name);
    if (!definition) throw new RuntimeFault("AGENT_NOT_FOUND", `助手类型不存在：${name}`);
    return structuredClone(definition);
  }
  list() {
    return [...this.definitions.values()].map((d) => ({
      name: d.name,
      description: d.description,
      model: d.model,
      workspaceMode: d.workspaceMode,
    }));
  }
}
