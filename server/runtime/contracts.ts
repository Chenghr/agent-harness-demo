export type AgentStatus =
  | "idle" | "running" | "thinking" | "waiting" | "awaiting_approval"
  | "verifying" | "needs_review" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";

export const terminalStatuses: ReadonlySet<string> = new Set([
  "completed", "failed", "cancelled", "interrupted", "needs_review",
]);

export type MessageSource = "user" | "parent" | "child" | "runtime";
export interface InboxMessage {
  id: string;
  source: MessageSource;
  content: string;
}

/** Narrow compatibility state. Only the controller writes control fields during a run. */
export interface ControlState {
  epoch: number;
  status: AgentStatus;
  result: string | null;
  finishedAt?: string;
  pendingModel: string | null;
  pendingMessages: Array<InboxMessage | string>;
  completion?: CompletionRecord;
}

export interface CompletionCheck {
  name: string;
  status: "passed" | "failed" | "unknown";
  detail: string;
}
export interface CompletionReport {
  verdict: "pass" | "revise" | "review";
  summary: string;
  checks: CompletionCheck[];
}
export interface CompletionRecord {
  id: string;
  version: string;
  epoch: number;
  attempt: number;
  report: CompletionReport;
  acceptedBy?: "checks" | "user";
}

export interface ExecutionLease {
  readonly epoch: number;
  readonly signal: AbortSignal;
  isActive(): boolean;
  assertActive(): void;
}

export type StepResult = { kind: "continue" } | { kind: "candidate"; text: string };
export type RunOutcome =
  | { kind: "completed"; text: string }
  | { kind: "needs_review"; text: string }
  | { kind: "cancelled"; error: RuntimeFault }
  | { kind: "failed"; error: RuntimeFault };

export interface ControllerPorts {
  isScopeOpen(): boolean;
  /** Commit the entire batch synchronously before notifying external observers. */
  admitInput(messages: readonly InboxMessage[]): void;
  step(lease: ExecutionLease): Promise<StepResult>;
  hasPendingWork(): boolean;
  /** Changes with requirements, relevant outputs and checker configuration; reads only. */
  completionVersion(): string;
  /** Read-only checks; must await owned work and respect the execution's cancellation signal. */
  verifyCompletion(text: string, lease: ExecutionLease): Promise<CompletionReport>;
  waitForWork(lease: ExecutionLease): Promise<void>;
  cancelDescendants(): Promise<void>;
  advanced(): void;
  statusChanged(status: AgentStatus): void;
  settled(outcome: RunOutcome, epoch: number): void;
  released(): void;
  event(type: string, data: Record<string, unknown>): void;
  messageId(): string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ModelResponse {
  text?: string;
  calls?: ToolCall[];
  rawResponse?: unknown;
}

/** Request and exchange representations belong to adapters, not to the loop. */
export interface LoopPorts<Request, Exchange> {
  prepare(lease: ExecutionLease): Promise<Request>;
  complete(request: Request, lease: ExecutionLease, onDelta: (text: string) => void): Promise<ModelResponse>;
  openExchange(response: ModelResponse): Exchange;
  appendResult(exchange: Exchange, call: ToolCall, result: unknown): void;
  closeExchange(exchange: Exchange): void;
  invoke(call: ToolCall, args: unknown, lease: ExecutionLease): Promise<unknown>;
  statusChanged(status: AgentStatus): void;
  event(type: string, data: Record<string, unknown>): void;
}

export class RuntimeFault extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeFault";
    this.code = code;
  }
}

export function asFault(error: unknown): RuntimeFault {
  if (error instanceof RuntimeFault) return error;
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : "RUNTIME_ERROR";
  return new RuntimeFault(code, error instanceof Error ? error.message : String(error));
}
