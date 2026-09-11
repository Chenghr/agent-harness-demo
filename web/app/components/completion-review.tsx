"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { CompletionRecord } from "../../../server/runtime/contracts.ts";

export type ReviewDecision = { reviewId: string; decision: "accept" | "revise"; feedback?: string };
export function CompletionReview({ status, completion, criteria, onReview }: {
  status: string;
  completion?: CompletionRecord;
  criteria?: string;
  onReview: (decision: ReviewDecision) => Promise<void>;
}) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!completion && !["verifying", "needs_review", "completed"].includes(status)) return null;
  const pending = status === "needs_review" && completion;
  const canAccept = completion?.report.verdict === "review"
    && !completion.report.checks.some((c) => c.status === "failed");
  async function decide(decision: "accept" | "revise") {
    if (!completion || busy) return;
    setBusy(true); setError("");
    try { await onReview({ reviewId: completion.id, decision, ...(decision === "revise" ? { feedback } : {}) }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return (
    <section className={`approval-card completion-card ${status === "completed" && completion?.acceptedBy ? "completion-accepted" : ""}`} aria-label="成果检查与验收">
      <strong>{status === "verifying" ? "正在检查成果…" : pending ? "成果待验收" : completion?.acceptedBy === "user" ? "用户已验收" : completion?.acceptedBy === "checks" ? "配置的检查已通过" : "成果检查记录"}</strong>
      {completion?.acceptedBy === "user" ? <p>验收方式：用户检查并确认。</p> : criteria && <p>检查范围：{criteria}</p>}
      {completion ? <>
        <p>{completion.acceptedBy === "user" ? "你已确认本次成果，自动检查未能判断的内容保留在下方记录中。" : completion.report.summary}</p>
        <ul className="completion-checks">
          {completion.report.checks.map((c, index) => (
            <li key={`${c.name}-${index}`}>
              <strong>{c.name} · {{ passed: "通过", failed: "未通过", unknown: completion.acceptedBy === "user" ? "由用户验收" : "待确认" }[c.status]}</strong>
              <details><summary>查看依据</summary><pre>{c.detail}</pre></details>
            </li>
          ))}
        </ul>
      </> : <p>{status === "verifying" ? "检查完成后才能确认任务是否完成。" : "此历史任务尚无成果验收记录。"}</p>}
      {pending && <>
        {!canAccept && <p>仍有明确未通过的检查，请说明修改要求后继续。</p>}
        <Textarea aria-label="成果修改要求" placeholder="需要补充或修改什么？" value={feedback} onChange={(e) => setFeedback(e.target.value)} disabled={busy} />
        <div className="approval-actions">
          <Button variant="outline" size="sm" disabled={busy || !feedback.trim()} onClick={() => decide("revise")}>按要求继续修改</Button>
          {canAccept && <Button size="sm" disabled={busy} onClick={() => decide("accept")}>我已验收，通过</Button>}
        </div>
      </>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
