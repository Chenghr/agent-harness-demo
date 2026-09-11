import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { RuntimeFault } from "./contracts.ts";

interface Resource {
  id: string;
  sessionId: string;
  agentId: string;
  pid?: number;
  startedAt: string;
  status: string;
}
interface Options {
  sessionId: string;
  agentId: string;
  cwd: string;
  args: string[];
  signal?: AbortSignal;
  timeout?: number;
  outputLimit?: number;
}
type Event = (type: string, data: Record<string, unknown>, sid: string, aid: string) => void;
function fault(code: string, message: string, details?: unknown) {
  return Object.assign(new RuntimeFault(code, message), { details });
}

/** Tracks controlled process groups, including descendants that close inherited pipes. */
export class ProcessManager {
  private readonly resources = new Map<string, Resource>();
  private readonly event: Event;
  constructor(event: Event) {
    this.event = event;
  }
  list(sessionId?: string) {
    return [...this.resources.values()].filter((r) => !sessionId || r.sessionId === sessionId);
  }
  async run({
    sessionId,
    agentId,
    cwd,
    args,
    signal,
    timeout = 15000,
    outputLimit = 200000,
  }: Options) {
    if (signal?.aborted) throw fault("CANCELLED", "操作已取消");
    const child = spawn(process.execPath, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
    });
    const resource: Resource = {
      id: `proc_${randomUUID().slice(0, 12)}`,
      sessionId,
      agentId,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.resources.set(resource.id, resource);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let output = "",
        truncated = false,
        cancelled = false,
        timeoutHit = false,
        closed = false,
        finished = false;
      let exitCode: number | null = null,
        exitSignal: NodeJS.Signals | null = null,
        spawnError: Error | undefined;
      let cleanupAt: number | undefined, poll: ReturnType<typeof setInterval> | undefined;
      const emit = (type: string, data: Record<string, unknown>) =>
        this.event(type, data, sessionId, agentId);
      const groupAlive = () => {
        if (!child.pid) return false;
        if (process.platform === "win32")
          return child.exitCode === null && child.signalCode === null;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      };
      const kill = (force: boolean) => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill(force ? "SIGKILL" : "SIGTERM");
          else process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            emit("process.cleanup_error", { resourceId: resource.id, message: String(error) });
        }
      };
      const finish = (clean: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        clearInterval(poll);
        signal?.removeEventListener("abort", stop);
        const result = {
          resourceId: resource.id,
          pid: child.pid,
          exitCode,
          exitSignal,
          output,
          truncated,
          cancelled,
          timeoutHit,
          cleanup: clean ? "released" : "unconfirmed",
        };
        if (!clean) {
          resource.status = "cleanup_unconfirmed";
          child.stdout.destroy();
          child.stderr.destroy();
          emit("process.cleanup_error", result);
          reject(fault("CLEANUP_FAILED", "无法确认进程组已经停止，资源记录保留", result));
          return;
        }
        this.resources.delete(resource.id);
        emit("process.exited", result);
        if (spawnError) reject(fault("PROCESS_ERROR", spawnError.message, result));
        else if (timeoutHit) reject(fault("TIMEOUT", "进程超时，已终止并回收", result));
        else if (cancelled) reject(fault("CANCELLED", "进程已停止并回收", result));
        else resolve(result);
      };
      const check = () => {
        const alive = groupAlive();
        if (closed && !alive) {
          finish(true);
          return;
        }
        if (cleanupAt === undefined) return;
        const elapsed = Date.now() - cleanupAt;
        if (alive && elapsed >= 600) kill(true);
        if (elapsed >= 2500) finish(false);
      };
      const cleanup = () => {
        if (cleanupAt !== undefined) return;
        cleanupAt = Date.now();
        resource.status = "cleaning";
        // Even a successful leader exit must not leave same-group background work behind.
        kill(false);
        poll = setInterval(check, 20);
      };
      const stop = () => {
        cancelled = true;
        cleanup();
      };
      const deadline = setTimeout(() => {
        timeoutHit = true;
        stop();
      }, timeout);
      const collect = (chunk: Buffer) => {
        const remaining = outputLimit - Buffer.byteLength(output);
        if (remaining > 0) output += chunk.subarray(0, remaining).toString();
        if (chunk.length > remaining) truncated = true;
        emit("process.output", { resourceId: resource.id, text: chunk.toString().slice(0, 3000) });
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", (error) => {
        spawnError = error;
      });
      child.on("exit", (code, sig) => {
        exitCode = code;
        exitSignal = sig;
        cleanup();
      });
      child.on("close", (code, sig) => {
        closed = true;
        exitCode = code;
        exitSignal = sig;
        cleanup();
        check();
      });
      signal?.addEventListener("abort", stop, { once: true });
      emit("process.started", { ...resource, command: `node ${args.join(" ")}` });
      if (signal?.aborted) stop();
    });
  }
}
