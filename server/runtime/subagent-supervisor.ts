import { RuntimeFault, terminalStatuses, asFault } from "./contracts.ts";
import type { ControlState, RunOutcome } from "./contracts.ts";
import type { Delegation } from "./agent-access.ts";
import type { AgentDefinitionRegistry } from "./agent-definitions.ts";

export interface SpawnRequest {
  goal: string;
  type?: string;
  files?: string[];
  artifacts?: string[];
  images?: string[];
  media?: string[];
  previews?: string[];
  background?: string;
  expectedOutput?: string;
  reason?: string;
  mode?: "foreground" | "background";
  model?: string;
}
export interface SubagentResult {
  resultId: string;
  agentId: string;
  status: string;
  text: string;
  model: string;
  requirementRevision: number;
  inputVersion: number;
  artifacts: string[];
  cleanup: "released" | "unconfirmed";
  textArtifactId?: string;
}
/** Keep result references intact when a long conclusion is handed back to a model. */
export function subagentReceipt(result: SubagentResult) {
  return {
    ...result,
    text: result.text.slice(0, 1000),
    textTruncated: result.text.length > 1000,
    artifacts: result.artifacts.slice(0, 8),
    artifactCount: result.artifacts.length,
  };
}
export interface ManagedAgent extends ControlState {
  id: string;
  parentId: string | null;
  goal: string;
  model: string;
  branchClosed?: boolean;
  delegation?: Delegation;
  output?: SubagentResult;
  ownedArtifacts?: string[];
  deadline?: number;
}
interface Tree<A> {
  id: string;
  closing: boolean;
  revision: number;
  agents: Record<string, A>;
}
interface Ports<A extends ManagedAgent> {
  scopeOpen(): boolean;
  model(name: string): void;
  create(parent: A, goal: string, model: string): A;
  prepare(parent: A, child: A, request: SpawnRequest): void;
  start(agent: A): void;
  fail(agent: A, error: unknown): void;
  cancel(agent: A): Promise<void>;
  active(agent: A): boolean;
  resources(agent: A): boolean;
  delivered(agent: A, result: SubagentResult): void;
  event(type: string, data: Record<string, unknown>, agent: A): void;
  resultId(): string;
}

/** Owns the tree and result delivery; business planning remains with the main model. */
export class SubagentSupervisor<A extends ManagedAgent> {
  private readonly closing = new Map<string, Promise<void>>();
  private readonly calls = new Map<string, { id: string; request: string }>();
  private readonly outcomes = new Map<string, RunOutcome>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tree: Tree<A>;
  private readonly ports: Ports<A>;
  private readonly definitions: AgentDefinitionRegistry;
  private readonly maxAgents: number;
  private readonly maxDepth: number;
  constructor(
    tree: Tree<A>,
    definitions: AgentDefinitionRegistry,
    ports: Ports<A>,
    maxAgents: number,
    maxDepth = 2,
  ) {
    this.tree = tree;
    this.definitions = definitions;
    this.ports = ports;
    this.maxAgents = maxAgents;
    this.maxDepth = maxDepth;
  }
  isDescendant(id: string, ancestor: string): boolean {
    let current = this.tree.agents[id];
    while (current?.parentId) {
      if (current.parentId === ancestor) return true;
      current = this.tree.agents[current.parentId];
    }
    return false;
  }
  isOpen(a: A): boolean {
    if (this.tree.closing || !this.ports.scopeOpen()) return false;
    let current: A | undefined = a;
    while (current) {
      if (
        current.branchClosed ||
        current.status === "cancelling" ||
        terminalStatuses.has(current.status)
      )
        return false;
      current = current.parentId ? this.tree.agents[current.parentId] : undefined;
    }
    return true;
  }
  live(a: A): boolean {
    return (
      !terminalStatuses.has(a.status) ||
      this.ports.active(a) ||
      this.ports.resources(a) ||
      this.outcomes.has(a.id)
    );
  }
  children(a: A) {
    return Object.values(this.tree.agents).filter((c) => c.parentId === a.id);
  }
  spawn(parent: A, request: SpawnRequest, callId?: string) {
    if (!this.isOpen(parent))
      throw new RuntimeFault("CLOSING", "父任务已关闭或正在取消，不能创建子任务");
    const key = callId ? `${parent.id}:${parent.epoch}:${callId}` : undefined;
    const existing = key ? this.calls.get(key) : undefined;
    if (existing) {
      if (existing.request !== JSON.stringify(request))
        throw new RuntimeFault("INVALID_ARGUMENT", "同一调用编号不能用于不同的子任务");
      return this.handle(this.tree.agents[existing.id]!);
    }
    if (typeof request.goal !== "string" || !request.goal.trim() || request.goal.length > 2000)
      throw new RuntimeFault("INVALID_ARGUMENT", "请提供清楚的子任务目标");
    const definition = this.definitions.get(request.type ?? "general");
    let ancestor: A | undefined = parent,
      depth = 1;
    if (parent.parentId && !parent.delegation?.definition.canDelegateTo.includes(definition.name))
      throw new RuntimeFault("POLICY_DENIED", "此助手不允许继续创建这种子助手");
    while (ancestor?.parentId) {
      depth++;
      const limit = ancestor.delegation?.definition;
      if (limit) {
        definition.tools = definition.tools.filter((n) => limit.tools.includes(n));
        definition.allowedSkills = definition.allowedSkills.filter((n) =>
          limit.allowedSkills.includes(n),
        );
        definition.allowedModels = definition.allowedModels.filter((n) =>
          limit.allowedModels.includes(n),
        );
        if (limit.workspaceMode === "read") definition.workspaceMode = "read";
        if (limit.permissionMode === "dontAsk") definition.permissionMode = "dontAsk";
        definition.maxCalls = Math.min(definition.maxCalls, limit.maxCalls);
      }
      ancestor = this.tree.agents[ancestor.parentId];
    }
    if (depth > this.maxDepth) throw new RuntimeFault("AGENT_DEPTH", "达到子任务深度上限");
    if (
      Object.values(this.tree.agents).filter((a) => a.parentId && this.live(a)).length >=
      this.maxAgents
    )
      throw new RuntimeFault("AGENT_LIMIT", "正在执行或清理的子助手已达上限，请等待已有任务");
    const model =
      request.model ?? (definition.model === "inherit" ? parent.model : definition.model);
    this.ports.model(model);
    if (!definition.allowedModels.includes(model))
      throw new RuntimeFault("POLICY_DENIED", "此助手不能使用指定模型");
    if (definition.skills.some((n) => !definition.allowedSkills.includes(n)))
      throw new RuntimeFault("POLICY_DENIED", "预加载 Skill 超出允许范围");
    const a = this.ports.create(parent, request.goal, model);
    a.delegation = {
      type: definition.name,
      definition,
      mode: request.mode ?? "background",
      background: request.background ?? "",
      expectedOutput: request.expectedOutput ?? "",
      reason: request.reason ?? "",
      requirementRevision: this.tree.revision,
      materials: [],
      artifactIds: [],
      inputVersion: 1,
    };
    a.branchClosed = false;
    a.deadline = Math.min(Date.now() + definition.timeoutMs, parent.deadline ?? Infinity);
    if (key) this.calls.set(key, { id: a.id, request: JSON.stringify(request) });
    try {
      this.ports.prepare(parent, a, request);
      this.ports.event(
        "agent.spawned",
        { id: a.id, parentId: parent.id, type: definition.name, model, mode: a.delegation.mode },
        a,
      );
      if (!this.isOpen(a)) throw new RuntimeFault("CANCELLED", "准备期间任务已取消");
      this.timers.set(
        a.id,
        setTimeout(
          () => {
            this.cancelTree(a.id, parent.id).catch((error) =>
              this.ports.event("cleanup.error", { message: String(error) }, a),
            );
          },
          Math.max(1, a.deadline - Date.now()),
        ),
      );
      this.ports.start(a);
    } catch (error) {
      if (!terminalStatuses.has(a.status)) this.ports.fail(a, error);
    }
    return this.handle(a);
  }
  handle(a: A) {
    return {
      agentId: a.id,
      status: a.status,
      background: a.delegation?.mode !== "foreground",
      type: a.delegation?.type,
      model: a.model,
    };
  }
  record(a: A, outcome: RunOutcome) {
    this.outcomes.set(a.id, outcome);
  }
  released(a: A) {
    if (!a.parentId || a.output || this.ports.active(a)) return;
    const outcome = this.outcomes.get(a.id);
    if (!outcome) return;
    clearTimeout(this.timers.get(a.id));
    this.timers.delete(a.id);
    a.output = {
      resultId: this.ports.resultId(),
      agentId: a.id,
      status: outcome.kind,
      text: "text" in outcome ? outcome.text : outcome.error.message,
      model: a.model,
      requirementRevision: a.delegation?.requirementRevision ?? this.tree.revision,
      inputVersion: a.delegation?.inputVersion ?? 1,
      artifacts: [...(a.ownedArtifacts ?? [])],
      cleanup: this.ports.resources(a) ? "unconfirmed" : "released",
    };
    this.ports.delivered(a, a.output);
    this.outcomes.delete(a.id);
  }
  assertManaged(id: string, parent: string): A {
    const a = this.tree.agents[id];
    if (!a || !this.isDescendant(id, parent))
      throw new RuntimeFault("NOT_FOUND", "子任务不存在或不属于当前助手");
    return a;
  }
  cancelTree(id: string, parent: string): Promise<void> {
    const a = this.assertManaged(id, parent);
    const current = this.closing.get(id);
    if (current) return current;
    const targets = Object.values(this.tree.agents).filter(
      (c) => c.id === id || this.isDescendant(c.id, id),
    );
    for (const target of targets) target.branchClosed = true;
    // Publish the shared promise before invoking any observable cancellation callbacks.
    const promise = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(targets.map((target) => this.ports.cancel(target)));
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw asFault(failed.reason);
      if (targets.some((target) => this.ports.resources(target)))
        throw new RuntimeFault("CLEANUP_FAILED", "仍有未确认的资源，不能报告全部停止");
      this.ports.event("agent.cancel_requested", { agentId: id }, a);
    });
    this.closing.set(id, promise);
    return promise;
  }
  async cancelChildren(a: A) {
    await Promise.all(this.children(a).map((c) => this.cancelTree(c.id, a.id)));
  }
  clear() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
