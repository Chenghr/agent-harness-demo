import { SubagentSupervisor, subagentReceipt } from "./runtime/subagent-supervisor.ts";
import { id } from "./core.mjs";
import { RuntimeFault } from "./runtime/contracts.ts";

export function createSupervisor(h, s) {
  return new SubagentSupervisor(
    s,
    h.agentDefinitions,
    {
      scopeOpen: () => !h.shuttingDown,
      model: (name) => {
        const m = h.models.get(name);
        if (!m.tools) throw new Error("模型不支持工具调用");
      },
      create: (parent, goal, model) =>
        h.agent(s, { agentId: id("agent"), parentId: parent.id, goal, model }),
      prepare(parent, child, request) {
        h.subagentWorkspace.prepare(s, parent, child, request);
        h.context.add(s, child, [
          {
            role: "user",
            content: JSON.stringify({
              goal: child.goal,
              background: child.delegation.background,
              expectedOutput: child.delegation.expectedOutput,
              materials: child.delegation.materials,
            }),
          },
        ]);
        for (const name of child.delegation.definition.skills)
          h.capabilityLoader.load(s, child, "skill", name);
        const input = h.context.build(s, child, h.models.get(child.model));
        if (input.tokens > input.available)
          throw new RuntimeFault("CONTEXT_LIMIT", "子助手的初始说明与能力超过模型输入预算");
      },
      start: (a) => h.launch(s, a),
      fail: (a, error) => h.controller(s, a).failBeforeStart(error),
      cancel: (a) => h.controller(s, a).cancel(),
      active: (a) => h.controllers.get(h.key(s, a))?.running ?? false,
      resources: (a) =>
        h.processes
          .list(s.id)
          .some((r) => r.agentId === a.id || h.supervisor(s).isDescendant(r.agentId, a.id)),
      delivered(a, result) {
        if (result.text.length > 1000) {
          result.textArtifactId = h.artifact(s, `${result.resultId}.txt`, result.text, a.id).id;
          result.artifacts.push(result.textArtifactId);
        }
        const parent = s.agents[a.parentId];
        if (parent && h.supervisor(s).isOpen(parent)) {
          parent.ownedArtifacts ??= [];
          // Results explicitly hand the child outputs to its parent, not its siblings.
          for (const artifactId of result.artifacts)
            if (!parent.ownedArtifacts.includes(artifactId)) parent.ownedArtifacts.push(artifactId);
          if (a.delegation?.mode !== "foreground") {
            const controller = h.controller(s, parent);
            controller.enqueue(
              `[子助手结果，作为资料核实] ${JSON.stringify({ ...subagentReceipt(result), stale: h.subagentWorkspace.stale(s, a) })}`,
              "child",
            );
            controller.start();
          }
        }
        h.event(
          s,
          `agent.${result.status}`,
          {
            result: result.text,
            resultId: result.resultId,
            cleanup: result.cleanup,
            epoch: a.epoch,
            stale: h.subagentWorkspace.stale(s, a),
          },
          a.id,
        );
      },
      event: (type, data, a) => h.event(s, type, data, a.id),
      resultId: () => id("result"),
    },
    h.maxAgents,
    h.maxAgentDepth,
  );
}
