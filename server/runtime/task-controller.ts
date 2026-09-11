import { asFault, RuntimeFault, terminalStatuses } from "./contracts.ts";
import { normalizeReport, repairFeedback, reviewRequired } from "./completion-check.ts";
import type {
  AgentStatus, ControllerPorts, ControlState, ExecutionLease, InboxMessage, MessageSource, RunOutcome,
} from "./contracts.ts";

interface ActiveRun {
  epoch: number;
  abort: AbortController;
  promise: Promise<void>;
  repairs: number;
  checks: number;
}

/** Serial control transitions; slow work runs outside these synchronous transitions. */
export class TaskController {
  private readonly state: ControlState;
  private readonly ports: ControllerPorts;
  private readonly maxSteps: number;
  private active: ActiveRun | undefined;
  private restart = false;
  private inputVersion = 0;
  private readonly maxRepairs: number;

  constructor(state: ControlState, ports: ControllerPorts, maxSteps = 1500, maxRepairs = 2) {
    this.state = state;
    this.ports = ports;
    this.maxSteps = maxSteps;
    if (!Number.isInteger(maxRepairs) || maxRepairs < 0) throw new Error("maxRepairs must be a nonnegative integer");
    this.maxRepairs = maxRepairs;
  }

  get running(): boolean { return this.active !== undefined; }
  get completion(): Promise<void> | undefined { return this.active?.promise; }
  get isTerminal(): boolean { return terminalStatuses.has(this.state.status); }

  /** A registered task can fail while preparing input, before a driver exists. */
  failBeforeStart(error: unknown): void {
    if (this.active) throw new RuntimeFault('RUNTIME_ERROR', '执行已经开始，不能按启动失败处理');
    const fault = asFault(error);
    this.settle({kind:fault.code==='CANCELLED'?'cancelled':'failed',error:fault}, ++this.state.epoch);
    this.ports.released();
  }

  setStatus(status: AgentStatus): void {
    this.state.status = status;
    this.ports.statusChanged(status);
  }

  enqueue(content: string, source: MessageSource): InboxMessage {
    const message = Object.freeze({ id: this.ports.messageId(), source, content });
    this.state.pendingMessages.push(message);
    this.inputVersion++;
    delete this.state.completion;
    this.ports.event("inbox.received", { message });
    return message;
  }

  /** A replacement run starts only after the previous driver has fully returned. */
  start(): Promise<void> | undefined {
    if (!this.ports.isScopeOpen()) return this.active?.promise;
    if (this.active) {
      if (this.isTerminal) this.restart = true;
      return this.active.promise;
    }
    this.restart = false;
    const abort = new AbortController();
    const epoch = ++this.state.epoch;
    const active: ActiveRun = { epoch, abort, promise: Promise.resolve(), repairs: 0, checks: 0 };
    delete this.state.completion;
    delete this.state.finishedAt;
    this.active = active;
    // Publish the handle before starting any user-observable callback.
    active.promise = Promise.resolve().then(() => this.drive(active)).finally(() => {
      if (this.active === active) this.active = undefined;
      const restart = this.restart && this.ports.isScopeOpen();
      this.restart = false;
      if (restart) this.start();
      this.ports.released();
    });
    return active.promise;
  }

  redirect(): void {
    if (!this.active || this.isTerminal) { this.start(); return; }
    this.restart = true;
    this.state.epoch++;
    this.setStatus("running");
    this.active.abort.abort(new RuntimeFault("CANCELLED", "用户已调整方向"));
  }

  cancel(): Promise<void> {
    this.restart = false;
    for (const message of this.state.pendingMessages.splice(0))
      this.ports.event("inbox.discarded", { message, reason: "任务取消" });
    if (this.isTerminal) return this.active?.promise ?? Promise.resolve();
    this.state.epoch++;
    if (!this.active) {
      this.settle({ kind: "cancelled", error: new RuntimeFault("CANCELLED", "操作已取消") }, this.state.epoch);
      this.ports.released();
      return Promise.resolve();
    }
    this.setStatus("cancelling");
    this.active.abort.abort(new RuntimeFault("CANCELLED", "操作已取消"));
    return this.active.promise;
  }

  private admitPendingInput(): void {
    const messages = this.state.pendingMessages.splice(0).map((value) =>
      typeof value === "string"
        ? { id: this.ports.messageId(), source: "user" as const, content: value } : value,
    );
    if (!messages.length) return;
    // Admission and its notification are separate: a notification may trigger a redirect.
    this.ports.admitInput(messages);
    for (const message of messages)
      this.ports.event("inbox.consumed", { messageId: message.id, source: message.source });
  }

  private settle(outcome: RunOutcome, epoch: number): void {
    this.state.status = outcome.kind;
    this.state.result = outcome.kind === "completed" || outcome.kind === "needs_review" ? outcome.text
      : outcome.kind === "failed" ? outcome.error.message : this.state.result;
    this.state.finishedAt = new Date().toISOString();
    // The adapter commits task facts before it publishes completion notifications.
    this.ports.settled(outcome, epoch);
  }

  private async tryComplete(text: string, lease: ExecutionLease, active: ActiveRun): Promise<"continue" | "wait" | "settled"> {
    lease.assertActive();
    if (this.state.pendingMessages.length || this.state.pendingModel) return "continue";
    if (this.ports.hasPendingWork()) return "wait";
    const inputVersion = this.inputVersion, version = this.ports.completionVersion();
    this.setStatus("verifying");
    this.ports.event("completion.started", { attempt: ++active.checks });
    lease.assertActive();
    let report;
    try { report = normalizeReport(await this.ports.verifyCompletion(text, lease)); }
    catch (error) { report = reviewRequired(`成果检查未能完成：${asFault(error).message}`); }
    lease.assertActive();
    const changed = () => inputVersion !== this.inputVersion || version !== this.ports.completionVersion()
      || this.state.pendingMessages.length > 0 || this.state.pendingModel !== null;
    if (changed()) {
      this.ports.event("completion.stale", { reason: "检查期间要求或结果已改变，重新决策和检查" });
      return "continue";
    }
    if (this.ports.hasPendingWork()) return "wait";
    const record = { id: this.ports.messageId(), version, epoch: lease.epoch, attempt: active.checks, report };
    this.state.completion = record;
    this.ports.event("completion.checked", { completion: record });
    // Event observers can submit new input synchronously too.
    lease.assertActive();
    if (changed()) { delete this.state.completion; return "continue"; }
    if (this.ports.hasPendingWork()) { delete this.state.completion; return "wait"; }
    if (report.verdict === "revise" && active.repairs < this.maxRepairs) {
      active.repairs++;
      this.enqueue(repairFeedback(report), "runtime");
      this.ports.event("completion.retry", { repair: active.repairs, limit: this.maxRepairs });
      return "continue";
    }
    if (report.verdict === "revise")
      report.summary += ` 已用完本轮 ${this.maxRepairs} 次自动返工机会，请调整要求后继续。`;
    // No await or callback between the last freshness checks and this terminal commit.
    if (report.verdict === "pass") {
      this.state.completion.acceptedBy = "checks";
      this.settle({ kind: "completed", text }, lease.epoch);
    } else this.settle({ kind: "needs_review", text }, lease.epoch);
    return "settled";
  }

  /** Human acceptance is separate from permission to execute tools. */
  acceptReview(id: string): void {
    const record = this.state.completion;
    if (this.running || this.state.status !== "needs_review" || !record || record.id !== id
      || record.epoch !== this.state.epoch || record.version !== this.ports.completionVersion()
      || this.state.pendingMessages.length || this.state.pendingModel || this.ports.hasPendingWork())
      throw new RuntimeFault("STALE_REVIEW", "待验收结果已改变，请重新执行检查");
    if (record.report.verdict === "revise" || record.report.checks.some((c) => c.status === "failed"))
      throw new RuntimeFault("CHECKS_FAILED", "仍有明确未通过的检查，请补充修改要求后继续");
    record.acceptedBy = "user";
    this.settle({ kind: "completed", text: this.state.result ?? "" }, this.state.epoch);
    this.ports.released();
  }

  private async drive(active: ActiveRun): Promise<void> {
    const lease: ExecutionLease = {
      epoch: active.epoch,
      signal: active.abort.signal,
      isActive: () => !active.abort.signal.aborted && this.state.epoch === active.epoch && this.ports.isScopeOpen(),
      assertActive: () => {
        if (!lease.isActive()) throw new RuntimeFault("CANCELLED", "操作已取消");
      },
    };
    try {
      lease.assertActive();
      this.setStatus("running");
      this.ports.event("agent.started", { epoch: active.epoch });
      for (let step = 0; step < this.maxSteps; step++) {
        lease.assertActive();
        this.admitPendingInput();
        lease.assertActive();
        const result = await this.ports.step(lease);
        if (result.kind === "candidate") {
          const decision = await this.tryComplete(result.text, lease, active);
          if (decision === "settled") return;
          if (decision === "wait") {
            this.setStatus("waiting");
            await this.ports.waitForWork(lease);
          }
        }
        this.ports.advanced();
      }
      throw new RuntimeFault("LOOP_LIMIT", "达到模型轮次上限，停止本轮执行");
    } catch (error) {
      let fault = asFault(error);
      if (!lease.isActive() || fault.code === "CANCELLED") {
        if (this.restart && this.ports.isScopeOpen())
          this.ports.event("agent.cancelled", { reason: fault.message, epoch: active.epoch, restarting: true });
        else this.settle({ kind: "cancelled", error: fault }, active.epoch);
      } else {
        try { await this.ports.cancelDescendants(); }
        catch (cleanupError) { fault = asFault(cleanupError); }
        // A user redirect or stop may have arrived while descendants were draining.
        if (!lease.isActive()) {
          if (!this.restart) this.settle({ kind: "cancelled", error: fault }, active.epoch);
        } else this.settle({ kind: "failed", error: fault }, active.epoch);
      }
    }
  }
}
