import { asFault, RuntimeFault } from "./contracts.ts";
import type { ExecutionLease, LoopPorts, StepResult } from "./contracts.ts";

/** One model decision and its complete tool exchange. No task, HTTP, or fixture knowledge. */
export class AgentLoop<Request, Exchange> {
  private readonly ports: LoopPorts<Request, Exchange>;
  constructor(ports: LoopPorts<Request, Exchange>) { this.ports = ports; }

  async step(lease: ExecutionLease): Promise<StepResult> {
    const p = this.ports;
    lease.assertActive();
    const request = await p.prepare(lease);
    lease.assertActive();
    p.statusChanged("thinking");
    lease.assertActive();
    const response = await p.complete(request, lease, (text) => {
      if (lease.isActive()) p.event("model.delta", { text });
    });
    if (!lease.isActive()) {
      p.event("model.stale", { epoch: lease.epoch, reason: "旧轮次已失效，未派发返回的工具" });
      lease.assertActive();
    }
    const calls = response.calls ?? [];
    if (calls.length > 32) throw new RuntimeFault("MODEL_PROTOCOL", "单轮工具请求过多，未执行");
    const exchange = p.openExchange(response);
    if (!calls.length) return { kind: "candidate", text: response.text ?? "" };

    p.statusChanged("running");
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      let result: unknown;
      try {
        lease.assertActive();
        let args: unknown;
        try { args = JSON.parse(call.function.arguments); }
        catch { throw new RuntimeFault("INVALID_ARGUMENT", "工具参数不是完整 JSON"); }
        result = await p.invoke(call, args, lease);
      } catch (error) {
        const fault = asFault(error);
        result = { error: { code: fault.code, message: fault.message } };
        const budgetExceeded = ["CALL_LIMIT", "LOOP_LIMIT"].includes(fault.code);
        if (!lease.isActive() || budgetExceeded) {
          p.appendResult(exchange, call, result);
          for (const pending of calls.slice(i + 1))
            p.appendResult(exchange, pending, {
              error: { code: "CANCELLED", message: "在执行前被取消" },
            });
          p.closeExchange(exchange);
          throw budgetExceeded ? fault : new RuntimeFault("CANCELLED", "操作已取消");
        }
      }
      // Completed effects are recorded even if a cancellation arrived during execution.
      p.appendResult(exchange, call, result);
    }
    p.closeExchange(exchange);
    return { kind: "continue" };
  }
}
