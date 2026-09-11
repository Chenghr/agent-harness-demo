import { WorkspaceManager } from "./workspaces.mjs";
import { DeliveryService } from "./delivery/service.mjs";
import { PermissionService, PERMISSION_MODES } from "./permissions.mjs";
import { executeWorkspaceTool } from "./workspace-tools.mjs";
import { Companion } from "./companion.mjs";
import { searchHistory } from "./context/history.mjs";
import { executeCommand } from "./command-tools.mjs";
import { validateTool } from "./tool-schema.mjs";
import { preserveToolResult } from "./tool-result.mjs";
import { CapabilityLoader, visibleTo } from "./capability-loader.mjs";
import { EvaluationQueue } from "./runtime/capabilities/evaluation.ts";
import { managementReviewer } from "./capability-reviewer.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentDefinitionRegistry } from "./runtime/agent-definitions.ts";
import { assertTool, relativePath, canRead, canReadArtifact } from "./runtime/agent-access.ts";
import { SubagentWorkspace } from "./subagent-workspace.mjs";
import { workspacePath } from "./workspace-access.mjs";
import { createSupervisor } from "./subagent-adapter.mjs";
import { subagentReceipt } from "./runtime/subagent-supervisor.ts";
import { EventEmitter } from "node:events";
import {
  Store,
  Semaphore,
  ProcessManager,
  HarnessError,
  id,
  now,
  delay,
  checkAbort,
  abortError,
  deferred,
  validate,
} from "./core.mjs";
import { Catalog } from "./catalog.mjs";
import { ContextManager } from "./context.mjs";
import { ModelRegistry, DemoModel, ApiModel } from "./models.mjs";
import { withoutProviderState } from "./model-history.mjs";
import { createWorkspace, SCENARIOS } from "./fixtures.mjs";
import { createTaskController } from "./runtime-adapter.mjs";
import { terminalStatuses as terminal } from "./runtime/contracts.ts";
import { CompletionChecks } from "./completion-checks.mjs";

export class Harness extends EventEmitter {
  constructor({
    root = ".harness",
    speed = 1,
    env = process.env,
    modelAdapter,
    completionCheck,
    modelConcurrency = 2,
    toolConcurrency = 4,
    maxCalls = 5000,
    maxAgents = 8,
    maxAgentDepth = 2,
    agentDefinitionsDir = fileURLToPath(new URL("../config/agents", import.meta.url)),
    deliveryOptions,
  } = {}) {
    super();
    this.store = new Store(root);
    this.catalog = new Catalog(path.join(this.store.root, "catalog"));
    this.models = new ModelRegistry(env, path.join(this.store.root, "settings"));
    this.workspaces = new WorkspaceManager(path.join(this.store.root, "user-workspaces"), {
      protectedRoots: [this.store.root],
    });
    this.permissions = new PermissionService(this);
    this.delivery = new DeliveryService(this, deliveryOptions);
    this.agentDefinitions = new AgentDefinitionRegistry(agentDefinitionsDir, {
      tools: [...this.catalog.tools.keys()],
      skills: [...this.catalog.skills.keys()],
      models: this.models.profiles.map((m) => m.id),
    });
    this.catalog.library.onChange = () => {
      this.catalog.refreshManaged();
      this.agentDefinitions.updateCatalog({
        tools: [...this.catalog.tools.keys()],
        skills: [...this.catalog.skills.keys()],
        models: this.models.profiles.map((m) => m.id),
      });
    };
    this.models.onChange = () => this.catalog.library.onChange();
    this.subagentWorkspace = new SubagentWorkspace(this);
    this.supervisors = new Map();
    this.demo = modelAdapter || new DemoModel(speed);
    this.apiModel = new ApiModel(this.models);
    this.context = new ContextManager(this);
    this.capabilityLoader = new CapabilityLoader(this);
    this.managementReviews = new Map();
    this.evaluations = new EvaluationQueue(this.catalog.library, managementReviewer(this));
    this.completionChecks = new CompletionChecks(this, completionCheck);
    this.modelSlots = new Semaphore(modelConcurrency);
    this.toolSlots = new Semaphore(toolConcurrency);
    this.processes = new ProcessManager((type, data, sid, aid) => {
      const s = this.sessions.get(sid);
      if (s) this.event(s, type, data, aid);
    });
    this.apiPorts = new Set();
    this.sessions = new Map();
    this.controllers = new Map();
    this.approvalWaiters = new Map();
    this.saveTimers = new Map();
    this.writeLocks = new Map();
    this.speed = speed;
    this.maxCalls = maxCalls;
    this.maxAgents = maxAgents;
    this.maxAgentDepth = maxAgentDepth;
    this.shuttingDown = false;
    this.companion = new Companion(this);
    for (const s of this.store.loadAll()) {
      // A log cannot prove a previously running process stopped. Never kill a recycled PID.
      if (!terminal.has(s.status) && s.status !== "idle") {
        s.status = "interrupted";
        s.closing = true;
        for (const agent of Object.values(s.agents))
          if (!terminal.has(agent.status)) agent.status = "interrupted";
        for (const a of s.actions)
          if (["queued", "running", "awaiting_approval"].includes(a.status)) {
            a.status = "interrupted";
            a.error = "后端重启，未自动重放操作；原在途操作需核对";
          }
        for (const a of s.approvals) if (a.status === "pending") a.status = "cancelled";
      }
      this.sessions.set(s.id, s);
      if (s.workspaceId) this.finishWorkspace(s);
      this.store.save(s);
    }
  }
  config() {
    return {
      version: "1.0.0",
      models: this.models.list(),
      imageModels: this.delivery.config.list().images,
      counts: this.catalog.counts(),
      scenarios: SCENARIOS,
      workspaces: this.workspaces.list(),
      permissionModes: PERMISSION_MODES,
      assistants: this.agentDefinitions.list(),
      limits: {
        maxCalls: this.maxCalls,
        maxAgents: this.maxAgents,
        modelConcurrency: this.modelSlots.limit,
        toolConcurrency: this.toolSlots.limit,
      },
      execution: { type: "controlled-local-processes", securitySandbox: false },
    };
  }
  get(sid) {
    const s = this.sessions.get(sid);
    if (!s) throw new HarnessError("NOT_FOUND", "任务不存在");
    return s;
  }
  event(session, type, data = {}, agentId = null) {
    session.updatedAt = now();
    const e = this.store.event(session.id, type, data, agentId);
    this.emit("event", e);
    if (type !== "model.delta" && !this.saveTimers.has(session.id)) {
      const timer = setTimeout(() => {
        this.saveTimers.delete(session.id);
        this.store.save(session);
        this.emit("state", session.id);
      }, 80);
      this.saveTimers.set(session.id, timer);
    }
    return e;
  }
  chat(session, role, text, model) {
    const item = { id: id("msg"), role, text, time: now(), ...(model ? { model } : {}) };
    session.chat.push(item);
    if (session.chat.length > 150) session.chat.shift();
    this.event(session, "chat.message", item);
    return item;
  }
  agent(session, { agentId = "main", parentId = null, goal, model }) {
    const a = {
      id: agentId,
      parentId,
      goal,
      model,
      status: "idle",
      epoch: 0,
      cursor: 0,
      plan: null,
      history: [],
      summary: "",
      loadedTools: [],
      loadedSkills: [],
      skillSnapshots: {},
      toolSnapshots: {},
      compactions: 0,
      compacting: false,
      pendingMessages: [],
      pendingModel: null,
      result: null,
      ownedArtifacts: [],
      branchClosed: false,
      toolCalls: 0,
      baseRevision: session.workspaceRevision,
      createdAt: now(),
    };
    session.agents[a.id] = a;
    return a;
  }
  create({
    prompt,
    scenario = "full",
    model = "demo-balanced",
    autoStart = true,
    workspaceId,
    permissionMode = "ask",
  } = {}) {
    if (this.shuttingDown) throw new HarnessError("CLOSING", "服务正在关闭");
    this.models.get(model);
    if (!PERMISSION_MODES.includes(permissionMode))
      throw new HarnessError("INVALID_ARGUMENT", "未知权限模式");
    if (workspaceId) {
      this.workspaces.get(workspaceId);
      scenario = "workspace";
    } else permissionMode = "ask";
    const selected = SCENARIOS.find((s) => s.id === scenario);
    prompt = String(prompt || selected?.prompt || "请分析购物车测试失败的原因。").trim();
    if (!prompt || prompt.length > 10000)
      throw new HarnessError("INVALID_ARGUMENT", "任务消息需要在 1 到 10000 字符之间");
    const session = {
      id: id("task"),
      title: selected?.name || prompt.slice(0, 28),
      createdAt: now(),
      updatedAt: now(),
      status: "idle",
      scenario,
      model,
      mainAgentId: "main",
      revision: 1,
      workspaceRevision: 0,
      workspaceId,
      permissionMode,
      closing: false,
      readOnly: /先不要修改|只分析|只读|不要修改文件|不要修改实现|只给分析|也先不要修改/.test(
        prompt,
      ),
      userRequirements: [prompt],
      agents: {},
      chat: [],
      actions: [],
      approvals: [],
      grants: [],
      grantVersion: 0,
      artifacts: [],
      handoffs: [],
      stats: { toolCalls: 0, succeeded: 0, failed: 0, cancelled: 0, fixtureCalls: 0 },
      restartUnverified: false,
    };
    session.workspace = workspaceId
      ? this.workspaces.get(workspaceId).path
      : createWorkspace(this.store.root, session.id, scenario);
    session.acceptance = this.completionChecks.configure(session);
    this.sessions.set(session.id, session);
    const a = this.agent(session, { goal: prompt, model });
    this.context.add(session, a, [{ role: "user", content: prompt }]);
    this.chat(session, "user", prompt);
    this.event(session, "session.created", { scenario, model });
    this.store.save(session);
    if (autoStart) this.launch(session, a);
    return this.snapshot(session.id);
  }
  snapshot(sid) {
    const s = this.get(sid);
    const agents = {};
    for (const a of Object.values(s.agents)) {
      const profile = this.models.profiles.find((p) => p.id === a.model);
      const built = profile ? this.context.build(s, a, profile) : { tokens: 0, budget: 0 };
      agents[a.id] = {
        id: a.id,
        parentId: a.parentId,
        goal: a.goal,
        status: a.output?.cleanup === "unconfirmed" ? "interrupted" : a.status,
        model: a.model,
        pendingModel: a.pendingModel,
        imageModelId: a.imageModelId,
        assignedImageIds: a.assignedImageIds,
        epoch: a.epoch,
        loadedTools: a.loadedTools,
        loadedSkills: a.loadedSkills,
        result: a.result,
        completion: a.completion,
        delegation: a.delegation
          ? {
              type: a.delegation.type,
              mode: a.delegation.mode,
              expectedOutput: a.delegation.expectedOutput,
              reason: a.delegation.reason,
              materials: a.delegation.materials,
              workspaceMode: a.delegation.definition.workspaceMode,
              permissionMode: a.delegation.definition.permissionMode,
              instructions: a.delegation.definition.instructions,
              tools: a.delegation.definition.tools,
              allowedModels: a.delegation.definition.allowedModels,
              version: a.delegation.definition.version,
            }
          : undefined,
        output: a.output,
        stale: a.parentId ? this.subagentWorkspace.stale(s, a) : false,
        baseRevision: a.baseRevision,
        context: {
          tokens: built.tokens,
          budget: built.budget,
          available: built.available,
          reserve: built.reserve,
          margin: built.margin,
          breakdown: built.breakdown,
          summary: a.summary,
          compactions: a.compactions,
          historyUnits: a.history.length,
          lastCompaction: a.lastCompaction,
        },
      };
    }
    return {
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      status: s.status,
      scenario: s.scenario,
      model: s.model,
      mainAgentId: s.mainAgentId,
      closing: s.closing,
      revision: s.revision,
      workspaceRevision: s.workspaceRevision,
      workspaceId: s.workspaceId,
      workspace: s.workspace,
      permissionMode: s.permissionMode ?? "ask",
      readOnly: s.readOnly,
      acceptance: s.acceptance,
      agents,
      delivery: this.delivery.snapshot(s),
      chat: s.chat,
      actions: s.actions,
      approvals: s.approvals,
      grants: s.grants,
      artifacts: s.artifacts,
      stats: s.stats,
      handoffs: s.handoffs,
      resources: this.processes.list(sid),
      events: (this.store.tail.get(sid) ?? [])
        .filter((e) => !["context.unit", "model.delta", "process.output"].includes(e.type))
        .slice(-100),
    };
  }
  list() {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        model: s.model,
        workspaceId: s.workspaceId,
        updatedAt: s.updatedAt,
      }));
  }
  key(s, a) {
    return `${s.id}:${a.id}`;
  }
  supervisor(s) {
    if (!this.supervisors.has(s.id)) this.supervisors.set(s.id, createSupervisor(this, s));
    return this.supervisors.get(s.id);
  }
  valid(s, a, epoch, signal) {
    checkAbort(signal);
    if (
      s.closing ||
      a.epoch !== epoch ||
      this.shuttingDown ||
      (a.parentId && !this.supervisor(s).isOpen(a))
    )
      throw abortError();
  }
  controller(s, a) {
    const key = this.key(s, a);
    if (!this.controllers.has(key)) this.controllers.set(key, createTaskController(this, s, a));
    return this.controllers.get(key);
  }
  get controls() {
    // A read-only compatibility snapshot; live drivers are owned by TaskController.
    return new Map(
      [...this.controllers]
        .filter(([, c]) => c.running)
        .map(([key, c]) => [key, { promise: c.completion }]),
    );
  }
  setStatus(s, a, status) {
    this.controller(s, a).setStatus(status);
  }
  beginWorkspace(s) {
    if (s.workspaceId) this.workspaces.begin(s.workspaceId, s.id, s.userRequirements.at(-1), true);
  }
  finishWorkspace(s) {
    if (!s.workspaceId) return;
    try {
      this.workspaces.finish(s.workspaceId, s.id, s.status);
    } catch (error) {
      s.status = "interrupted";
      s.checkpointError = error.message;
      this.event(s, "workspace.checkpoint_failed", { message: error.message });
    }
  }
  rollbackWorkspace(sid, roundId, paths) {
    const s = this.get(sid);
    if (!s.workspaceId) throw new HarnessError("INVALID_ARGUMENT", "此任务不是用户工作区");
    if (this.controller(s, s.agents.main).running || this.processes.list(sid).length)
      throw new HarnessError("WORKSPACE_BUSY", "请先停止任务并等待资源回收");
    const result = this.workspaces.rollback(s.workspaceId, sid, roundId, paths);
    s.workspaceRevision++;
    s.revision++;
    s.status = "idle";
    s.closing = true;
    s.agents.main.completion = undefined;
    s.agents.main.result = null;
    s.agents.main.status = "idle";
    s.agents.main.history = [];
    s.agents.main.summary = "";
    this.context.add(s, s.agents.main, [
      {
        role: "user",
        content: `已从修改记录 ${roundId} 撤销这些文件：${result.changes.map(c => c.path).join("、")}。其余文件保持现状。旧验证结果已失效，后续任务必须重新读取文件。原任务要求：${s.userRequirements.join("\n")}`,
      },
    ]);
    this.chat(s, "system", `已撤销所选 ${result.changes.length} 个文件的修改。保留对话记录，旧验证结果已失效。`);
    this.event(s, "workspace.rolled_back", result);
    this.store.save(s);
    return result;
  }
  launch(s, a) {
    if (!a.parentId) this.beginWorkspace(s);
    return this.controller(s, a).start();
  }
  async invoke(
    s,
    a,
    name,
    args,
    { signal = new AbortController().signal, epoch = a.epoch, callId = id("call") } = {},
  ) {
    const action = {
      id: callId,
      model: a.model,
      requirementRevision: s.revision,
      agentId: a.id,
      tool: name,
      args,
      status: "queued",
      startedAt: now(),
      epoch,
    };
    const started = Date.now();
    s.actions.push(action);
    s.stats.toolCalls++;
    while (s.actions.length > 200) {
      const removable = s.actions.findIndex(
        (item) => terminal.has(item.status) || ["succeeded", "denied"].includes(item.status),
      );
      if (removable < 0) break;
      s.actions.splice(removable, 1);
    }
    try {
      this.valid(s, a, epoch, signal);
      if (s.stats.toolCalls > this.maxCalls)
        throw new HarnessError("CALL_LIMIT", "达到本任务工具调用预算");
      if (
        ["file_write", "run_tests", "run_diagnostic", "agent_spawn"].includes(name) &&
        this.processes.list(s.id).some((resource) => resource.status === "cleanup_unconfirmed")
      )
        throw new HarnessError("CLEANUP_FAILED", "仍有资源未确认回收，暂停新的写入、执行和委派");
      assertTool(a, name);
      let owner = a;
      while (owner?.parentId) {
        owner.toolCalls = (owner.toolCalls ?? 0) + 1;
        if (owner.toolCalls > (owner.delegation?.definition.maxCalls ?? this.maxCalls))
          throw new HarnessError("CALL_LIMIT", "达到子助手调用预算");
        owner = s.agents[owner.parentId];
      }
      const definition = a.toolSnapshots?.[name] ?? this.catalog.getTool(name);
      if (!this.catalog.library.get(name).enabled)
        throw new HarnessError("CAPABILITY_DISABLED", "工具未启用，登记说明不等于获得执行权限");
      validateTool(definition.parameters, args);
      if (!definition.always && !a.loadedTools.includes(name))
        throw new HarnessError("TOOL_NOT_LOADED", `先通过 tool_load 加载 ${name}`);
      if (
        s.workspaceId &&
        !a.parentId &&
        ["file_read", "file_write", "file_edit", "file_delete", "shell_run"].includes(name)
      ) {
        this.beginWorkspace(s);
        await this.permissions.authorize(s, a, action, signal);
      } else if (name === "file_write") await this.authorize(s, a, action, signal);
      this.valid(s, a, epoch, signal);
      action.status = "running";
      this.event(s, "tool.started", { tool: name, args, callId }, a.id);
      const execute = () => this.execute(s, a, name, args, signal, epoch, action);
      const result =
        ["run_tests", "run_diagnostic", "shell_run", "image_generate"].includes(name) ||
        definition.adapter === "node-command-v1"
          ? await this.toolSlots.run(execute, signal)
          : await execute();
      action.status = "succeeded";
      action.result = preserveToolResult(this, s, a, name, result);
      s.stats.succeeded++;
      if (definition.simulated) s.stats.fixtureCalls++;
      this.event(
        s,
        "tool.succeeded",
        { tool: name, callId, result: action.result, duration: Date.now() - started },
        a.id,
      );
      return action.result;
    } catch (error) {
      action.status =
        error.code === "CANCELLED"
          ? "cancelled"
          : ["POLICY_DENIED", "PATH_DENIED", "APPROVAL_DENIED"].includes(error.code)
            ? "denied"
            : "failed";
      action.error = error.message;
      action.code = error.code ?? "TOOL_ERROR";
      if (action.status === "cancelled") s.stats.cancelled++;
      else s.stats.failed++;
      this.event(
        s,
        action.status === "cancelled" ? "tool.cancelled" : "tool.failed",
        { tool: name, callId, code: action.code, message: action.error },
        a.id,
      );
      throw error;
    } finally {
      action.duration = Date.now() - started;
      action.finishedAt = now();
    }
  }
  async authorize(s, a, action, signal) {
    action.authorizedGrantVersion = s.grantVersion;
    const relative = relativePath(action.args.path);
    workspacePath(this.workspace(s, a), a, relative, "write");
    if (s.readOnly) throw new HarnessError("POLICY_DENIED", "用户当前要求只读分析，不允许写入");
    if (
      s.grants.some(
        (g) =>
          (g.agentId ?? "main") === a.id &&
          g.tool === action.tool &&
          relativePath(g.path) === relative,
      )
    )
      return;
    if (a.delegation?.definition.permissionMode === "dontAsk")
      throw new HarnessError("APPROVAL_DENIED", "此助手不申请额外授权，操作未执行");
    action.status = "awaiting_approval";
    this.setStatus(s, a, "awaiting_approval");
    const approval = {
      id: id("approval"),
      actionId: action.id,
      agentId: a.id,
      tool: action.tool,
      args: structuredClone(action.args),
      epoch: a.epoch,
      revision: s.revision,
      grantVersion: s.grantVersion,
      status: "pending",
      createdAt: now(),
    };
    s.approvals.push(approval);
    const pending = deferred();
    this.approvalWaiters.set(approval.id, pending);
    const cancel = () => {
      if (approval.status === "pending") {
        approval.status = "cancelled";
        pending.reject(abortError());
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    this.event(s, "approval.requested", { ...approval }, a.id);
    try {
      await pending.promise;
      this.valid(s, a, action.epoch, signal);
      if (approval.grantVersion !== s.grantVersion || s.readOnly)
        throw new HarnessError("APPROVAL_DENIED", "授权条件已改变，未执行写入");
    } finally {
      signal.removeEventListener("abort", cancel);
      this.approvalWaiters.delete(approval.id);
      if (!signal.aborted && !s.closing) this.setStatus(s, a, "running");
    }
  }
  approve(sid, approvalId, decision) {
    const s = this.get(sid),
      approval = s.approvals.find((a) => a.id === approvalId);
    const pending = this.approvalWaiters.get(approvalId);
    if (!["once", "task", "deny"].includes(decision))
      throw new HarnessError("INVALID_ARGUMENT", "未知授权决定");
    if (!approval || !pending || approval.status !== "pending")
      throw new HarnessError("STALE_APPROVAL", "该授权请求已经失效");
    const a = s.agents[approval.agentId];
    if (
      s.closing ||
      a.epoch !== approval.epoch ||
      s.revision !== approval.revision ||
      s.grantVersion !== approval.grantVersion
    ) {
      approval.status = "cancelled";
      pending.reject(abortError());
      throw new HarnessError("STALE_APPROVAL", "任务已经改变，旧批准不能继续执行");
    }
    if (approval.scope === "once" && decision === "task")
      throw new HarnessError("INVALID_ARGUMENT", "此操作只支持单次批准");
    approval.status = decision === "deny" ? "denied" : "approved";
    if (decision === "task")
      s.grants.push({
        id: id("grant"),
        tool: approval.tool,
        agentId: a.id,
        path: approval.args.path,
        createdAt: now(),
      });
    this.event(s, "approval.resolved", { approvalId, decision }, a.id);
    if (decision === "deny")
      pending.reject(new HarnessError("APPROVAL_DENIED", "用户拒绝本次操作"));
    else pending.resolve();
    return this.snapshot(sid);
  }
  revoke(sid) {
    const s = this.get(sid);
    s.grants = [];
    s.grantVersion++;
    for (const approval of s.approvals)
      if (approval.status === "pending") {
        approval.status = "cancelled";
        this.approvalWaiters
          .get(approval.id)
          ?.reject(new HarnessError("APPROVAL_DENIED", "用户撤销授权"));
      }
    this.event(s, "approval.revoked", {});
    return this.snapshot(sid);
  }
  artifact(s, name, content, agentId = "main") {
    const artifact = this.store.artifact(s.id, name, content, agentId);
    const owner = s.agents[agentId];
    if (owner) {
      owner.ownedArtifacts ??= [];
      owner.ownedArtifacts.push(artifact.id);
    }
    s.artifacts.push(artifact);
    if (s.artifacts.length > 150) s.artifacts.shift();
    this.event(s, "artifact.created", artifact, agentId);
    return artifact;
  }
  workspace(s, a) {
    return a.parentId
      ? s.workspaceId
        ? path.join(this.store.root, "agent-workspaces", s.id, a.id)
        : path.join(s.workspace, "agents", a.id)
      : s.workspace;
  }
  async execute(s, a, name, args, signal, epoch, action) {
    this.valid(s, a, epoch, signal);
    const workspace = this.workspace(s, a);
    if (name === "image_models") return { models: this.delivery.config.list().images };
    if (name === "image_generate") return this.delivery.generate(s, a, args, signal, epoch);
    if (name === "site_preview") return this.delivery.preview(s, a, args);
    if (name === "greeting_site") return this.delivery.greeting(s, a, args);
    if (name === "site_request_publish") return this.delivery.requestPublish(s, a, args.previewId);
    if (
      s.workspaceId &&
      !a.parentId &&
      [
        "file_list",
        "file_read",
        "file_write",
        "file_search",
        "file_edit",
        "file_delete",
        "shell_run",
      ].includes(name)
    )
      return executeWorkspaceTool(this, s, a, name, args, signal, epoch, action);
    if (["file_search", "file_edit", "file_delete", "shell_run"].includes(name))
      throw new HarnessError(
        "POLICY_DENIED",
        "通用文件和命令工具需要选择用户工作区，且由主助手执行",
      );
    if (s.workspaceId && ["run_tests", "run_diagnostic"].includes(name))
      throw new HarnessError("POLICY_DENIED", "示例执行工具不能用于真实工作区，请使用 shell_run");
    if (name === "catalog_browse")
      return this.catalog.library.browse(args.directory ?? "root", {
        offset: args.offset,
        kind: args.kind,
        visible: visibleTo(a),
      });
    if (name === "catalog_search")
      return this.catalog.library.search(args.query, {
        directory: args.directory ?? "root",
        kind: args.kind,
        offset: args.offset,
        visible: visibleTo(a),
        limit: 8,
      });
    if (name === "catalog_detail") {
      const item = this.catalog.library.get(args.name);
      if (!item.enabled || !visibleTo(a)(item))
        throw new HarnessError("POLICY_DENIED", "能力不在当前助手可见范围");
      return {
        name: item.name,
        title: item.title,
        description: item.description,
        version: item.version,
        source: item.source,
        trust: item.trust,
        dependencies: item.dependencies,
        permissions: item.permissions,
        quality: item.reports.filter((r) => r.kind === "quality").at(-1),
        safety: item.reports.filter((r) => r.kind === "safety").at(-1),
        scan: item.scan,
        stages: Object.keys(item.structure?.stages ?? {}),
      };
    }
    if (name === "tool_load" || name === "skill_load")
      return this.capabilityLoader.load(
        s,
        a,
        name === "tool_load" ? "tool" : "skill",
        args.name,
        args.stage,
      );
    if (name === "tool_unload" || name === "skill_unload")
      return this.unload(s, a, name === "tool_unload" ? "tool" : "skill", args.name);
    if (name === "skill_read_resource")
      return this.capabilityLoader.read(
        a,
        args.name,
        args.path,
        args.offset,
        args.limit,
        args.query,
      );
    if (name === "file_list") {
      const files = [];
      const walk = (dir = "") => {
        for (const entry of fs.readdirSync(path.join(workspace, dir), { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory() && (file === "outputs" || file === "inputs")) walk(file);
          else if (entry.isFile() && canRead(a, file)) files.push(file);
        }
      };
      walk();
      if (a.delegation)
        for (const material of a.delegation.materials)
          if (!files.includes(material.path)) files.push(material.path);
      return { files };
    }
    if (name === "file_read") {
      const file = workspacePath(workspace, a, args.path);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        throw new HarnessError("NOT_FOUND", "文件不存在");
      const content = fs.readFileSync(file, "utf8");
      if (content.length > 8000) {
        const artifact = this.artifact(s, path.basename(file), content, a.id);
        return {
          path: args.path,
          content: content.slice(0, 1800),
          artifactId: artifact.id,
          truncated: true,
        };
      }
      return {
        path: args.path,
        content,
        workspaceRevision: a.parentId ? a.baseRevision : s.workspaceRevision,
      };
    }
    if (name === "file_write") {
      const lockKey = a.parentId ? this.key(s, a) : s.id;
      let lock = this.writeLocks.get(lockKey);
      if (!lock) {
        lock = new Semaphore(1);
        this.writeLocks.set(lockKey, lock);
      }
      return lock.run(async () => {
        this.valid(s, a, epoch, signal);
        if (s.readOnly) throw new HarnessError("POLICY_DENIED", "用户要求只读");
        if (action.authorizedGrantVersion !== s.grantVersion)
          throw new HarnessError("APPROVAL_DENIED", "授权已撤销，排队中的写入没有执行");
        const file = workspacePath(workspace, a, args.path, "write");
        const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${id("write")}.tmp`;
        try {
          fs.writeFileSync(temporary, args.content, { flag: "wx" });
          fs.renameSync(temporary, file);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
        const artifact = this.artifact(
          s,
          `${path.basename(file)}.change.txt`,
          `--- 修改前\n${before}\n+++ 修改后\n${args.content}`,
          a.id,
        );
        const outputArtifact = a.parentId
          ? this.artifact(s, path.basename(file), args.content, a.id)
          : artifact;
        if (!a.parentId) s.workspaceRevision++;
        else a.outputRevision = (a.outputRevision ?? 0) + 1;
        return {
          path: args.path,
          bytes: Buffer.byteLength(args.content),
          workspaceRevision: s.workspaceRevision,
          artifactId: outputArtifact.id,
        };
      }, signal);
    }
    if (name === "run_tests" || name === "run_diagnostic") {
      if (name === "run_tests") {
        workspacePath(workspace, a, "cart.test.mjs");
        workspacePath(workspace, a, "cart.mjs");
      }
      const duration = args.duration ?? Math.max(100, 4000 * this.speed);
      const processArgs =
        name === "run_tests"
          ? ["--test", "cart.test.mjs"]
          : [
              "-e",
              `let i=0; const t=setInterval(()=>console.log('diagnostic tick '+(++i)),200); setTimeout(()=>{clearInterval(t);console.log('diagnostic completed')},${duration});`,
            ];
      try {
        const result = await this.processes.run({
          sessionId: s.id,
          agentId: a.id,
          cwd: workspace,
          args: processArgs,
          signal,
          timeout: name === "run_tests" ? 15000 : duration + 3000,
        });
        const artifact = this.artifact(s, `${name}-${a.id}.log`, result.output, a.id);
        return {
          exitCode: result.exitCode,
          output: result.output.slice(-1600),
          artifactId: artifact.id,
          pid: result.pid,
          workspaceRevision: a.parentId ? a.baseRevision : s.workspaceRevision,
        };
      } catch (error) {
        if (error.details?.output)
          this.artifact(s, `${name}-${a.id}-interrupted.log`, error.details.output, a.id);
        throw error;
      }
    }
    if (name === "generate_logs") {
      const logs = Array.from(
        { length: Math.floor(args.lines) },
        (_, i) =>
          `[模拟诊断 ${i + 1}] quantity=${(i % 4) + 1}, unitPrice=12.50, observation=检查数量乘积与折扣，原始证据保持外部可查询。`,
      ).join("\n");
      const artifact = this.artifact(s, "diagnostic-fixture.log", logs, a.id);
      return {
        simulated: true,
        lines: args.lines,
        artifactId: artifact.id,
        preview: logs.slice(0, 1400),
        note: "完整日志在产物中，未将全部输出注入上下文",
      };
    }
    if (name === "artifact_read") {
      if (!canReadArtifact(a, args.id))
        throw new HarnessError("PATH_DENIED", "产物没有分配给当前助手");
      const art = this.store.readArtifact(s.id, args.id);
      const offset = Math.floor(args.offset ?? 0);
      return {
        id: art.id,
        name: art.name,
        content: art.content.slice(offset, offset + 1800),
        offset,
        nextOffset: offset + 1800 < art.content.length ? offset + 1800 : null,
        total: art.content.length,
      };
    }
    if (name === "history_search") return searchHistory(this, s, a, args);
    if (name === "agent_spawn") {
      const ref = this.spawnAgent(s, a, args, action.id);
      if (args.mode === "foreground") {
        await this.waitChildren(s, a, signal, ref.agentId);
        const child = s.agents[ref.agentId];
        return { ...subagentReceipt(child.output), stale: this.subagentWorkspace.stale(s, child) };
      }
      return ref;
    }
    if (name === "agent_status")
      return {
        agents: Object.values(s.agents)
          .filter((c) => c.parentId && (!a.parentId || this.isDescendant(s, c.id, a.id)))
          .map((c) => ({
            id: c.id,
            parentId: c.parentId,
            status: c.status,
            goal: c.goal,
            result: c.result,
            model: c.model,
            resultId: c.output?.resultId,
            cleanup: c.output?.cleanup,
            stale: this.subagentWorkspace.stale(s, c),
          })),
      };
    if (name === "agent_message")
      return this.messageAgent(s.id, args.agentId, args.message, a.id, args.mode);
    if (name === "agent_cancel") {
      if (args.agentId === a.id)
        throw new HarnessError("INVALID_ARGUMENT", "不能通过子任务取消工具取消自身");
      await this.cancelAgent(s.id, args.agentId, a.id);
      return { cancelled: true };
    }
    if (name === "agent_wait") return this.waitChildren(s, a, signal, undefined, true);
    if (name === "context_compact")
      return this.context.compact(s, a, { signal, force: true, delayMs: 120 * this.speed });
    const definition = a.toolSnapshots?.[name] ?? this.catalog.getTool(name);
    if (definition.adapter === "node-command-v1")
      return executeCommand(this, s, a, definition, args, signal);
    return this.catalog.compute(name, args, definition);
  }
  spawnAgent(s, parent, request, callId) {
    request = typeof request === "string" ? { goal: request } : request;
    validate(this.catalog.getTool("agent_spawn").parameters, request);
    return this.supervisor(s).spawn(parent, request, callId);
  }
  unload(s, a, kind, name) {
    if (!["tool", "skill"].includes(kind))
      throw new HarnessError("INVALID_ARGUMENT", "未知能力类型");
    if (kind === "tool") {
      const t = this.catalog.getTool(name);
      if (t.always) throw new HarnessError("POLICY_DENIED", "基础控制工具不能卸载");
      if (
        s.actions.some(
          (action) =>
            action.agentId === a.id &&
            action.tool === name &&
            ["running", "queued", "awaiting_approval"].includes(action.status),
        )
      )
        throw new HarnessError("TOOL_BUSY", "工具仍有未完成调用，暂不能卸载");
      a.loadedTools = a.loadedTools.filter((item) => item !== name);
      if (a.toolSnapshots) delete a.toolSnapshots[name];
    } else {
      this.catalog.getSkill(name);
      a.loadedSkills = a.loadedSkills.filter((item) => item !== name);
      delete a.skillSnapshots[name];
    }
    a.contextVersion = (a.contextVersion ?? 0) + 1;
    this.event(s, `${kind}.unloaded`, { name, note: "后续停止注入，历史事实继续保留" }, a.id);
    return { unloaded: name, historyPreserved: true };
  }
  isDescendant(s, agentId, ancestorId) {
    return this.supervisor(s).isDescendant(agentId, ancestorId);
  }
  async waitChildren(s, a, signal, onlyId, interruptible = false) {
    this.setStatus(s, a, "waiting");
    try {
      const children = () =>
        onlyId ? [this.supervisor(s).assertManaged(onlyId, a.id)] : this.supervisor(s).children(a);
      while (children().some((child) => this.supervisor(s).live(child))) {
        this.valid(s, a, a.epoch, signal);
        if (children().some((child) => child.output?.cleanup === "unconfirmed"))
          throw new HarnessError("CLEANUP_FAILED", "后台资源尚未确认回收");
        if (interruptible && (a.pendingMessages.length || a.pendingModel)) break;
        await delay(20, signal);
      }
      return {
        agents: children().map((child) => ({
          ...this.supervisor(s).handle(child),
          result: child.result,
          resultId: child.output?.resultId,
          stale: this.subagentWorkspace.stale(s, child),
        })),
      };
    } finally {
      if (!signal.aborted && !s.closing) this.setStatus(s, a, "running");
    }
  }
  messageAgent(sid, aid, message, parentId = "main", mode = "append", source = "parent") {
    const s = this.get(sid),
      a = this.supervisor(s).assertManaged(aid, parentId);
    if (!this.supervisor(s).isOpen(a))
      throw new HarnessError("CLOSING", "子任务已经结束或正在取消");
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 2000 ||
      !["append", "steer"].includes(mode)
    )
      throw new HarnessError("INVALID_ARGUMENT", "补充说明或模式无效");
    a.delegation.inputVersion++;
    a.delegation.requirementRevision = s.revision;
    const controller = this.controller(s, a);
    controller.enqueue(message, source);
    if (mode === "steer") {
      a.plan = null;
      a.cursor = 0;
      a.goal = message;
      this.cancelDescendants(s, a.id).catch((error) =>
        this.event(s, "cleanup.error", { message: error.message }, a.id),
      );
      controller.redirect();
    }
    this.event(s, "agent.message", { message, mode }, aid);
    return { queued: true };
  }
  userMessage(sid, { text, mode = "append", agentId } = {}) {
    if (!agentId || agentId === "main") return this.message(sid, text, mode);
    const result = this.messageAgent(sid, agentId, text, "main", mode, "user");
    this.chat(this.get(sid), "user", `发给子助手：${text}`);
    return result;
  }
  retryAgent(sid, aid, { message, model } = {}) {
    const s = this.get(sid), old = this.supervisor(s).assertManaged(aid, "main");
    if (!old.output || this.supervisor(s).live(old))
      throw new HarnessError("CLOSING", "请等待此子任务结束或停止后再重做");
    const parent = s.agents[old.parentId];
    if (parent.id !== "main") throw new HarnessError("POLICY_DENIED", "请由直接父助手重新分配嵌套任务");
    const request = {
      goal: message || old.goal, type: old.delegation.type, model: model || old.model,
      files: old.delegation.materials.filter(m => m.sourcePath).map(m => m.sourcePath),
      artifacts: old.delegation.artifactIds,
      images: old.assignedImageIds ?? [],
      background: old.delegation.background, expectedOutput: old.delegation.expectedOutput,
      mode: "background",
    };
    validate(this.catalog.getTool("agent_spawn").parameters, request);
    this.models.get(request.model);
    if (!old.delegation.definition.allowedModels.includes(request.model))
      throw new HarnessError("POLICY_DENIED", "重做不能扩大原助手的模型范围");
    if (s.closing) this.message(sid, `重新处理子任务：${request.goal}。其他已完成成果保留。`, "append");
    const ref = this.spawnAgent(s, parent, request);
    s.agents[ref.agentId].replacesAgentId = aid;
    s.agents[ref.agentId].imageModelId = old.imageModelId;
    this.event(s, "agent.retried", { previousAgentId: aid, agentId: ref.agentId }, ref.agentId);
    return ref;
  }
  async cancelAgent(sid, aid, parentId = "main") {
    await this.supervisor(this.get(sid)).cancelTree(aid, parentId);
    return { cancelled: true };
  }
  async cancelDescendants(s, aid) {
    await this.supervisor(s).cancelChildren(s.agents[aid]);
  }
  message(sid, text, mode = "append") {
    const s = this.get(sid),
      a = s.agents.main;
    if (typeof text !== "string" || !text.trim() || text.length > 10000)
      throw new HarnessError("INVALID_ARGUMENT", "消息需要在 1 到 10000 字符之间");
    if (!["append", "steer"].includes(mode))
      throw new HarnessError("INVALID_ARGUMENT", "未知消息处理方式");
    if (s.status === "cancelling")
      throw new HarnessError("CLOSING", "正在清理资源，请在停止完成后继续");
    s.userRequirements.push(text);
    s.revision++;
    this.chat(s, "user", text);
    if (
      /先不要修改|只分析|只读|不要修改文件|不要修改实现|只给分析|只给建议|不要改文件/.test(text)
    ) {
      s.readOnly = true;
      this.revoke(sid);
    }
    if (/允许修改|可以修改|现在修复|继续修复/.test(text)) s.readOnly = false;
    const controller = this.controller(s, a);
    const continuing = !controller.running || controller.isTerminal;
    if (continuing) {
      this.beginWorkspace(s);
      s.closing = false;
      a.branchClosed = false;
      if (s.scenario === "interrupt" || s.scenario === "scale") s.scenario = "custom";
    }
    controller.enqueue(text, "user");
    if (mode === "steer" || continuing) {
      a.plan = null;
      a.cursor = 0;
      a.goal = text;
      a.result = null;
      s.status = "running";
      if (mode === "steer" && !continuing) controller.redirect();
      else controller.start();
      if (mode === "steer") {
        this.cancelDescendants(s, a.id).catch((error) =>
          this.event(s, "cleanup.error", { message: error.message }),
        );
        if (/停止诊断|取消后台|停止后台/.test(text)) s.scenario = "custom";
      }
      this.event(s, "session.steered", { text, revision: s.revision });
    } else this.event(s, "session.message_queued", { text });
    return this.snapshot(sid);
  }
  async stop(sid) {
    const s = this.get(sid);
    if (s.status === "cancelled") return this.snapshot(sid);
    s.closing = true;
    s.status = "cancelling";
    s.revision++;
    await this.delivery.cancel(s);
    this.revoke(sid);
    this.event(s, "session.cancel_requested", {});
    for (const a of Object.values(s.agents)) a.branchClosed = true;
    const waits = Object.values(s.agents).map((a) => this.controller(s, a).cancel());
    const stopped = await Promise.allSettled(waits);
    const failures = stopped.filter((result) => result.status === "rejected");
    for (const failure of failures)
      this.event(s, "cleanup.error", { message: String(failure.reason) });
    s.status = this.processes.list(sid).length || failures.length ? "interrupted" : "cancelled";
    this.chat(
      s,
      "system",
      s.status === "cancelled"
        ? "任务已停止。受管理的本地进程已回收，已完成的操作与原始记录保留。"
        : "任务停止仍有未确认资源，请检查事件记录。",
    );
    if (!this.processes.list(sid).length) this.finishWorkspace(s);
    this.event(s, "session.stopped", { resources: this.processes.list(sid).length });
    this.store.save(s);
    return this.snapshot(sid);
  }
  reviewCompletion(sid, { reviewId, decision, feedback } = {}) {
    const s = this.get(sid),
      a = s.agents.main,
      controller = this.controller(s, a);
    if (
      this.shuttingDown ||
      s.status !== "needs_review" ||
      controller.running ||
      typeof reviewId !== "string" ||
      a.completion?.id !== reviewId
    )
      throw new HarnessError("STALE_REVIEW", "待验收结果已改变，请查看最新结果");
    if (decision === "accept") controller.acceptReview(reviewId);
    else if (decision === "revise") {
      if (typeof feedback !== "string" || !feedback.trim())
        throw new HarnessError("INVALID_ARGUMENT", "请说明需要补充或修改的内容");
      return this.message(sid, feedback, "steer");
    } else throw new HarnessError("INVALID_ARGUMENT", "未知验收操作");
    return this.snapshot(sid);
  }
  requestSwitch(sid, model, agentId = "main") {
    const s = this.get(sid),
      a = agentId === "main" ? s.agents.main : this.supervisor(s).assertManaged(agentId, "main");
    if (a.parentId && !this.supervisor(s).isOpen(a))
      throw new HarnessError("CLOSING", "子任务已结束，请通过重做选择新模型");
    if (a.parentId && !a.delegation.definition.allowedModels.includes(model))
      throw new HarnessError("POLICY_DENIED", "此助手不能使用指定模型");
    const target = this.models.get(model);
    if (!target.tools)
      throw new HarnessError("MODEL_INCOMPATIBLE", "目标模型不支持任务需要的工具调用");
    if (model === a.model) { a.pendingModel = null; return this.snapshot(sid); }
    a.pendingModel = model;
    this.event(s, "model.switch_requested", { from: a.model, to: model }, a.id);
    if (!this.controller(s, a).running)
      return this.applySwitch(s, a, model, new AbortController().signal)
        .then(() => this.snapshot(sid)).catch(error => {
          if (a.pendingModel === model) a.pendingModel = null;
          throw error;
        });
    this.chat(
      s,
      "system",
      `已请求${a.parentId ? "指定子助手" : "主助手"}切换模型，将在当前工具交互完整结束后交接。其他助手保持原模型。`,
    );
    return this.snapshot(sid);
  }
  async applySwitch(s, a, model, signal) {
    const target = this.models.get(model),
      from = a.model,
      revision = s.revision,
      epoch = a.epoch;
    const contextVersion = a.contextVersion ?? 0;
    const historyStamp = JSON.stringify(a.history);
    const handoff = {
      agentId: a.id,
      from,
      to: model,
      time: now(),
      facts: this.context.facts(s, a),
      summary: a.summary,
      skills: [...a.loadedSkills],
      tools: [...a.loadedTools],
      note: "保留可见事实与证据，不迁移模型内部状态。",
    };
    // Retain every visible history unit. Only compact if the target needs it;
    // remove provider-specific hidden payloads when crossing model boundaries.
    const candidate = {
      ...a,
      model,
      compacting: false,
      history: [
        {
          id: id("unit"),
          time: now(),
          complete: true,
          messages: [
            { role: "user", content: "[模型交接] 已完成操作不得重复执行；继续遵守现有要求。" },
          ],
        },
        ...a.history.map(withoutProviderState),
      ],
    };
    let input = this.context.build(s, candidate, target);
    if (input.tokens > input.available) {
      await this.context.compact(s, candidate, {
        signal,
        profile: target,
        delayMs: 0,
        detached: true,
      });
      input = this.context.build(s, candidate, target);
    }
    checkAbort(signal);
    if (
      s.revision !== revision ||
      a.epoch !== epoch ||
      (a.contextVersion ?? 0) !== contextVersion ||
      a.pendingModel !== model ||
      JSON.stringify(a.history) !== historyStamp
    )
      throw new HarnessError("HANDOFF_STALE", "交接期间任务已改变，未提交");
    if (input.tokens > input.available) {
      a.pendingModel = null;
      this.event(
        s,
        "model.switch_failed",
        { from, to: model, reason: "必要交接信息超过目标窗口" },
        a.id,
      );
      throw new HarnessError("CONTEXT_LIMIT", "交接信息超过目标模型窗口，保持原模型和上下文");
    }
    if (candidate.pendingContextArchive) {
      const pending = candidate.pendingContextArchive;
      const saved = this.artifact(s, "context-checkpoint.json", pending.content, a.id);
      candidate.summary = candidate.summary.replace(pending.placeholder, saved.id);
      candidate.lastCompaction = {
        ...candidate.lastCompaction,
        archiveId: saved.id,
        summary: candidate.summary,
      };
    }
    const artifact = this.artifact(
      s,
      "model-handoff.json",
      JSON.stringify(
        { ...handoff, history: candidate.history, summary: candidate.summary },
        null,
        2,
      ),
      a.id,
    );
    a.model = model;
    a.summary = candidate.summary;
    a.compactions = candidate.compactions;
    a.lastCompaction = candidate.lastCompaction;
    a.history = candidate.history;
    a.contextVersion = (a.contextVersion ?? 0) + 1;
    a.pendingModel = null;
    if (!a.parentId) s.model = model;
    s.handoffs.push({ ...handoff, artifactId: artifact.id });
    this.event(
      s,
      "model.switched",
      {
        from,
        to: model,
        inputTokens: input.tokens,
        artifactId: artifact.id,
        preservedGrants: s.grants.length,
      },
      a.id,
    );
    this.chat(
      s,
      "system",
      `${a.parentId ? "子助手" : "主助手"}已从 ${this.models.profiles.find((p) => p.id === from)?.label ?? from} 切换为 ${target.label}。目标、约束、执行结果和有效授权已交接；其他任务保持原模型。`,
    );
  }
  async close() {
    this.shuttingDown = true;
    await this.delivery.close();
    await this.companion.close();
    await this.context.close();
    for (const review of this.managementReviews.values()) review.controller.abort();
    await Promise.allSettled([...this.managementReviews.values()].map((r) => r.promise));
    await this.evaluations.close();
    const active = [...this.sessions.values()].filter(
      (s) =>
        (!terminal.has(s.status) && s.status !== "idle") ||
        Object.values(s.agents).some((a) => this.controllers.get(this.key(s, a))?.running),
    );
    await Promise.allSettled(active.map((s) => this.stop(s.id)));
    for (const supervisor of this.supervisors.values()) supervisor.clear();
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    for (const s of this.sessions.values()) {
      if (!this.processes.list(s.id).length) this.finishWorkspace(s);
      this.store.save(s);
    }
    this.catalog.library.close();
  }
}
