import { assertSkill, assertTool, toolAllowed } from "./runtime/agent-access.ts";
import { HarnessError } from "./core.mjs";

export const visibleTo = (agent) => (item) =>
  item.kind === "tool"
    ? toolAllowed(agent, item.name)
    : !agent.parentId || agent.delegation?.definition.allowedSkills.includes(item.name);
const aliases = { Read: "file_read", Write: "file_write" };
/** One synchronous prepare/commit boundary for model calls, UI and child preloads. */
export class CapabilityLoader {
  constructor(harness) {
    this.h = harness;
  }
  load(session, agent, kind, name, stage) {
    const h = this.h;
    if (!["skill", "tool"].includes(kind))
      throw new HarnessError("INVALID_ARGUMENT", "未知能力类型");
    const list = kind === "skill" ? "loadedSkills" : "loadedTools";
    const snapshots = kind === "skill" ? "skillSnapshots" : "toolSnapshots";
    if (kind === "skill") assertSkill(agent, name);
    else assertTool(agent, name);
    const already = agent[snapshots]?.[name];
    if (agent[list].includes(name) && already && (!stage || already?.stage === stage))
      return {
        name,
        version: already?.version,
        loaded: true,
        deduplicated: true,
        permissionGranted: false,
      };
    if (agent[list].length >= (kind === "skill" ? 8 : 24) && !agent[list].includes(name))
      throw new HarnessError(
        kind === "skill" ? "SKILL_LIMIT" : "TOOL_LIMIT",
        "活跃能力已达上限，请先卸载不再需要的内容",
      );
    const item = h.catalog.library.get(name);
    if (!item.enabled)
      throw new HarnessError("CAPABILITY_DISABLED", "该能力尚未启用，请先在管理页面处理");
    let snapshot;
    if (kind === "skill") {
      const files = h.catalog.library.package(item.id, already?.version ?? item.version);
      const unresolved = item.dependencies.filter(
        (d) =>
          d.required &&
          (!h.catalog.tools.has(aliases[d.name] ?? d.name) ||
            h.catalog.tools.get(aliases[d.name] ?? d.name)?.enabled === false ||
            !toolAllowed(agent, aliases[d.name] ?? d.name)),
      );
      if (unresolved.length)
        throw new HarnessError(
          "DEPENDENCY_MISSING",
          `必要依赖不可用：${unresolved.map((d) => d.name).join("、")}`,
        );
      for (const relation of h.catalog.library.repo.list("relations")) {
        if (
          relation.type === "contradiction" &&
          relation.confirmed &&
          relation.versions?.includes(item.version) &&
          relation.ids?.includes(item.id) &&
          agent.loadedSkills.some((n) => {
            const active = h.catalog.library.get(n);
            return (
              relation.ids.includes(active.id) &&
              relation.versions.includes(agent.skillSnapshots[n]?.version)
            );
          })
        )
          throw new HarnessError(
            "SKILL_CONFLICT",
            "与已加载 Skill 有人工确认的矛盾；请先卸载冲突项或换用其他能力",
          );
      }
      const structure = already?.structure ?? item.structure;
      let paths = [item.entry];
      if (stage) {
        if (!structure?.confirmed || !structure.stages[stage])
          throw new HarnessError("INVALID_ARGUMENT", "该阶段没有经过确认的共同规则与内容");
        paths = [...new Set([...structure.global, ...structure.stages[stage]])];
      }
      snapshot = {
        content: paths.map((p) => `【${p}】\n${files[p]}`).join("\n\n"),
        version: already?.version ?? item.version,
        source: item.source,
        untrusted: item.untrusted,
        managedId: item.id,
        entry: item.entry,
        structure,
        stage,
        resources: Object.keys(files).filter((p) => !paths.includes(p)),
        dependencies: item.dependencies.map((d) => ({
          ...d,
          actualTool: aliases[d.name] ?? d.name,
        })),
      };
    } else {
      snapshot = structuredClone(h.catalog.getTool(name));
    }
    const candidate = {
      ...agent,
      [list]: [...new Set([...agent[list], name])],
      [snapshots]: { ...agent[snapshots], [name]: snapshot },
    };
    const context = h.context.build(session, candidate, h.models.get(agent.model));
    if (context.tokens > context.available)
      throw new HarnessError(
        "CONTEXT_LIMIT",
        "无法完整加载；请压缩历史、卸载其他内容，或确认共同规则后分阶段加载",
      );
    agent[list] = candidate[list];
    agent[snapshots] = candidate[snapshots];
    agent.contextVersion = (agent.contextVersion ?? 0) + 1;
    h.event(
      session,
      `${kind}.loaded`,
      { name, version: snapshot.version, stage, source: item.source, tokens: context.tokens },
      agent.id,
    );
    return {
      name,
      version: snapshot.version,
      loaded: true,
      stage,
      resources: snapshot.resources,
      dependencies: snapshot.dependencies,
      permissionGranted: false,
    };
  }
  read(agent, name, resource, offset = 0, limit = 1800, query = "") {
    assertSkill(agent, name);
    const snapshot = agent.skillSnapshots?.[name];
    if (!agent.loadedSkills.includes(name) || !snapshot)
      throw new HarnessError("SKILL_NOT_LOADED", "先加载该 Skill");
    const files = this.h.catalog.library.package(snapshot.managedId ?? name, snapshot.version);
    if (!Object.hasOwn(files, resource))
      throw new HarnessError("PATH_DENIED", "资源不属于加载的文件包");
    const content = files[resource];
    if (query)
      return {
        name,
        path: resource,
        version: snapshot.version,
        matches: content
          .split("\n")
          .flatMap((line, index) =>
            line.toLowerCase().includes(query.toLowerCase())
              ? [{ line: index + 1, text: line }]
              : [],
          )
          .slice(offset, offset + Math.min(50, limit)),
        source: "skill-resource",
      };
    const start = Math.max(0, offset),
      end = Math.min(content.length, start + Math.min(6000, Math.max(1, limit)));
    return {
      name,
      path: resource,
      version: snapshot.version,
      content: content.slice(start, end),
      offset: start,
      total: content.length,
      nextOffset: end < content.length ? end : null,
      source: "skill-resource",
    };
  }
}
