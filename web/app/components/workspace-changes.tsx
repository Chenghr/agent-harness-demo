'use client';
import { useEffect, useState, useCallback } from 'react';
import { runtimeApi } from './runtime-settings';
type Round = {
  id: string;
  label: string;
  status: string;
  startedAt: string;
  afterCommit?: string;
  revertedAt?: string;
  changes: { path: string; kind: string }[];
  files?: { path: string; kind: string; before: string; after: string }[];
};
export function WorkspaceChanges({
  sessionId,
  active,
  onChanged,
}: {
  sessionId: string;
  active: boolean;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<Round | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]),
    [detail, setDetail] = useState<Round | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(
    () => runtimeApi<Round[]>(`/sessions/${sessionId}/changes`).then(setRounds),
    [sessionId],
  );
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh, active]);
  async function undo(r: Round) {
    setBusy(true);
    setError('');
    try {
      await runtimeApi(`/sessions/${sessionId}/changes`, { roundId: r.id });
      setDetail(null);
      setPending(null);
      await refresh();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace-changes">
      <p className="runtime-hint">
        每轮执行保存前后版本，停止或失败也保留修改。仅恢复已记录的工作区文件；外部发送、工作区外修改不在范围内。
      </p>
      {error && (
        <p role="alert" className="runtime-error">
          {error}
        </p>
      )}
      {!rounds.length && <p>本次对话还没有文件记录。</p>}
      {pending && (
        <section className="rollback-confirm" aria-label="确认撤销修改">
          <strong>撤销「{pending.label}」这一轮的文件修改？</strong>
          <p>保留对话记录。遇到后续修改会报告冲突，不覆盖用户内容。</p>
          <div className="runtime-actions">
            <button disabled={busy} onClick={() => void undo(pending)}>
              确认撤销
            </button>
            <button disabled={busy} onClick={() => setPending(null)}>
              取消
            </button>
          </div>
        </section>
      )}
      {rounds.map((r) => (
        <article key={r.id}>
          <strong>{r.label}</strong>
          <small>
            {new Date(r.startedAt).toLocaleString()} · {r.changes.length} 个文件
            ·{' '}
            {r.revertedAt
              ? '已撤销'
              : r.status === 'running'
                ? '执行中'
                : r.afterCommit?.slice(0, 8)}
          </small>
          <div className="runtime-actions">
            <button
              disabled={!r.afterCommit}
              onClick={() =>
                runtimeApi<Round>(`/sessions/${sessionId}/changes/${r.id}`)
                  .then(setDetail)
                  .catch((e) => setError(e.message))
              }
            >
              查看修改
            </button>
            <button
              disabled={
                active ||
                busy ||
                !r.afterCommit ||
                !!r.revertedAt ||
                !r.changes.length
              }
              onClick={() => setPending(r)}
            >
              撤销这一轮
            </button>
          </div>
        </article>
      ))}
      {detail?.files?.map((f) => (
        <details key={f.path} open>
          <summary>
            {f.path} · {f.kind}
          </summary>
          <div className="change-columns">
            <div>
              <small>修改前</small>
              <pre>{f.before || '（不存在或为空）'}</pre>
            </div>
            <div>
              <small>修改后</small>
              <pre>{f.after || '（不存在或为空）'}</pre>
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}
