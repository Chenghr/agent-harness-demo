export type Kind = "skill" | "tool";
export type Files = Record<string, string>;
export interface Finding {
  rule: string;
  file: string;
  line: number;
  evidence: string;
  severity: "info" | "review" | "block";
  reason: string;
  suggestion: string;
  origin: "rule" | "model";
}
export interface Dependency {
  name: string;
  required: boolean;
  origin: "author" | "analysis";
}
export interface Capability {
  id: string;
  name: string;
  originalName: string;
  title: string;
  description: string;
  kind: Kind;
  source: string;
  sources: string[];
  version: string;
  authorVersion?: string;
  entry: string;
  format: string;
  claims: Record<string, unknown>;
  enabled: boolean;
  directories: string[];
  simulated: boolean;
  untrusted?: boolean;
  seeded?: boolean;
  scan: { findings: Finding[]; coverage: string[]; semantic: "not-run"; rules: string };
  permissions: {
    operation: string;
    target: string;
    origin: "author" | "analysis";
    evidence: string;
  }[];
  dependencies: Dependency[];
  compatibility: string[];
  trust: {
    trusted: boolean;
    scope?: "item" | "source";
    reason?: string;
    verified: boolean;
    verification?: string;
  };
  reports: Report[];
  structure?: { global: string[]; stages: Record<string, string[]>; confirmed: boolean };
  tool?: Record<string, unknown>;
}
export interface Evidence {
  file: string;
  line: number;
  quote: string;
}
export interface Grade {
  dimension: string;
  score: number | null;
  status: "scored" | "uncovered" | "not-applicable";
  evidence: Evidence[];
  reason: string;
  suggestion: string;
}
export interface Report {
  id: string;
  kind: "quality" | "safety";
  version: string;
  date: string;
  rules: string;
  model: string | null;
  coverage: string[];
  gaps: string[];
  overall?: number | null;
  grades?: Grade[];
  risk?: "low" | "medium" | "high" | "insufficient";
  findings?: Finding[];
  critical: string[];
  sections?: { title: string; judgment: string; evidence: Evidence[]; suggestion: string }[];
}
export interface Directory {
  id: string;
  parent: string | null;
  name: string;
  abstract: string;
  overview: string;
  origin: "generated" | "manual";
  stale: boolean;
  version: number;
  basedOn: string;
  suggestedAbstract?: string;
  suggestedOverview?: string;
}
export interface Conflict {
  type: "duplicate" | "name" | "update" | "similar" | "contradiction";
  otherId: string;
  otherVersion: string;
  evidence: string[];
  suggestion: string;
  confirmed: boolean;
}
export interface Pending {
  id: string;
  record: Capability;
  conflicts: Conflict[];
  status: "pending" | "resolved" | "skipped";
  decision?: Decision;
  resultId?: string;
}
export interface Decision {
  action: "keep" | "skip" | "attach-source" | "replace" | "save-disabled" | "dismiss";
  directories?: string[];
  displayName?: string;
  reason?: string;
}
export interface ImportInput {
  kind: Kind;
  source: string;
  files: Files;
  entry?: string;
  name?: string;
  description?: string;
}
export interface BrowseOptions {
  limit?: number;
  offset?: number;
  kind?: Kind | "all";
  visible?: (item: Capability) => boolean;
  management?: boolean;
}
export function fault(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
}
