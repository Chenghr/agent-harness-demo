'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  Send,
  Square,
  ThumbsUp,
  ThumbsDown,
  Download,
  ExternalLink,
  Minus,
  GripHorizontal,
} from 'lucide-react';
import './companion.css';
type Evidence = {
  seq: number;
  type: string;
  excerpt: string;
  truncated?: boolean;
};
type PetMessage = {
  id: string;
  role: string;
  text: string;
  model?: string;
  simulated?: boolean;
  time?: string;
  statusAtRead?: string;
  revision?: number;
  stale?: boolean;
  sources?: Evidence[];
};
type PetState = {
  progress: {
    title: string;
    status: string;
    label: string;
    completed: number;
    failed: number;
    model: string;
    revision: number;
    lastMessage: string | null;
    latest: { id: string; tool: string; status: string } | null;
    children: { id: string; goal: string; status: string }[];
  };
  messages: PetMessage[];
  busy: boolean;
  feedbackCount: number;
};
async function request<T>(
  sid: string,
  route = '',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sid)}/companion${route}`,
    body === undefined
      ? { signal }
      : {
          signal,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data: unknown = await res.json();
  if (!res.ok) {
    const error =
      data && typeof data === 'object' && 'error' in data ? data.error : null;
    throw new Error(
      error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : '连接失败',
    );
  }
  return data as T;
}
function native(action: string) {
  const w = window as unknown as {
    webkit?: {
      messageHandlers?: { pet?: { postMessage: (v: string) => void } };
    };
  };
  w.webkit?.messageHandlers?.pet?.postMessage(action);
}
// A small vector character belongs to this application's UI; no external sprites or runtime dependencies.
export function PetFace({ mood = 'idle' }: { mood?: string }) {
  return (
    <svg
      className={`pet-face pet-${mood}`}
      viewBox="0 0 120 114"
      aria-hidden="true"
    >
      <g className="pet-body">
        <path
          d="M27 45 Q15 12 36 24 L47 33 Q61 29 74 33 L87 22 Q104 15 94 48 Q104 65 96 85 Q88 98 62 98 Q31 99 23 83 Q17 64 27 45Z"
          fill="#f3f0e8"
          stroke="#42453f"
          strokeWidth="2.4"
          strokeLinejoin="round"
        />
        <path
          d="M34 91 Q27 110 44 106 M80 92 Q88 109 72 106"
          fill="#f3f0e8"
          stroke="#42453f"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <g className="pet-eyes">
          <ellipse cx="44" cy="59" rx="3" ry="4" fill="#42453f" />
          <ellipse cx="77" cy="59" rx="3" ry="4" fill="#42453f" />
        </g>
        <path
          className="pet-mouth"
          d={
            mood === 'egg' || mood === 'failed'
              ? 'M55 77 Q60 71 66 77'
              : 'M55 73 Q60 79 66 73'
          }
          fill="none"
          stroke="#42453f"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M28 70 L35 72 M86 72 L93 70"
          stroke="#c8b6a1"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {mood === 'egg' && (
          <g className="pet-egg-splash">
            <path
              d="M70 29 Q98 20 98 41 Q108 62 87 65 Q63 66 66 47 Q54 38 70 29"
              fill="#fffdf3"
              stroke="#ddd7c8"
            />
            <circle cx="84" cy="43" r="9" fill="#e8bb55" />
          </g>
        )}
      </g>
    </svg>
  );
}
function CompanionPanel({
  sessionId,
  standalone = false,
  open,
  setOpen,
}: {
  sessionId: string | null;
  standalone?: boolean;
  open: boolean;
  setOpen: (v: boolean | ((old: boolean) => boolean)) => void;
}) {
  const [state, setState] = useState<PetState | null>(null),
    [text, setText] = useState(''),
    [sending, setSending] = useState(false),
    [error, setError] = useState(''),
    [note, setNote] = useState(''),
    [reaction, setReaction] = useState(''),
    [reactionTick, setReactionTick] = useState(0),
    [quiet, setQuiet] = useState(false),
    [target, setTarget] = useState('task'),
    [reason, setReason] = useState(''),
    [confirmClear, setConfirmClear] = useState(false);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const generation = useRef(0),
    end = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const current = generation.current;
    const result = await request<PetState>(sessionId);
    if (current === generation.current) {
      setState(result);
      setError('');
    }
  }, [sessionId]);
  useEffect(() => {
    const token = ++generation.current;
    let disposed = false;
    const update = () =>
      refresh().catch((e) => {
        if (!disposed) setError(e.message);
      });
    void update();
    const timer = setInterval(() => void update(), 2500);
    return () => {
      disposed = true;
      generation.current = -token;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!reaction) return;
    const timer = setTimeout(() => setReaction(''), 1800);
    return () => clearTimeout(timer);
  }, [reaction]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [state?.messages.length, open]);
  async function send() {
    if (!sessionId || !text.trim() || sending) return;
    const current = generation.current;
    setSending(true);
    setError('');
    const question = text;
    setText('');
    try {
      await request(
        sessionId,
        '/messages',
        { text: question },
        lifetime.current.signal,
      );
      if (current === generation.current) await refresh();
    } catch (e) {
      if (current === generation.current) {
        setError((e as Error).message);
        setText(question);
      }
    } finally {
      if (current === generation.current) setSending(false);
    }
  }
  async function feedback(kind: string, quick = false) {
    setReaction(kind);
    setReactionTick((v) => v + 1);
    setNote(
      kind === 'slow'
        ? '收到，等得有点久了。'
        : kind === 'egg'
          ? '收到这颗鸡蛋。'
          : '收到你的反馈。',
    );
    if (!sessionId) return;
    let ref: { type: string; id: string } = { type: 'task', id: sessionId };
    if (!quick && target === 'message' && state?.progress.lastMessage)
      ref = { type: 'message', id: state.progress.lastMessage };
    if (!quick && target === 'action' && state?.progress.latest)
      ref = { type: 'action', id: state.progress.latest.id };
    if (!quick && target.startsWith('pet:'))
      ref = { type: 'companion', id: target.slice(4) };
    try {
      await request(sessionId, '/feedback', {
        kind,
        target: ref,
        reason: kind === 'slow' ? '太慢了' : quick ? '' : reason,
      });
      setNote(
        kind === 'egg'
          ? '收到这颗鸡蛋。已记下你对这次表现的反馈。'
          : '反馈已记录',
      );
      setReaction(kind);
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function exportData() {
    if (!sessionId) return;
    if (new URLSearchParams(window.location.search).has('native')) {
      native('open');
      setNote('请在打开的网页小伴中导出记录');
      return;
    }
    try {
      const data = await request(sessionId, '/export');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `companion-${sessionId}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const busy = sending || state?.busy;
  return (
    <div className={`companion ${standalone ? 'companion-standalone' : ''}`}>
      {open && (
        <section className="pet-panel" aria-label="小伴独立对话">
          <header>
            <span onPointerDown={() => native('drag')} title="拖动桌面窗口">
              <GripHorizontal size={15} /> 小伴
            </span>
            <div>
              <button
                aria-label="导出宠物对话与反馈"
                title="导出对话与反馈"
                onClick={exportData}
              >
                <Download size={15} />
              </button>
              <button
                aria-label="收起小伴"
                onClick={() => {
                  setOpen(false);
                  native('collapse');
                }}
              >
                <Minus size={16} />
              </button>
              {standalone && (
                <button
                  aria-label="退出桌面宠物"
                  onClick={() => native('close')}
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </header>
          <div className="pet-progress">
            <strong>
              {state?.progress.label ??
                (sessionId ? '正在连接…' : '还没有任务')}
            </strong>
            <span>
              {state?.progress.title ?? '开始一个任务后，我会帮你留意进展。'}
            </span>
            {state?.progress.latest && (
              <small>
                最近操作 · {state.progress.latest.tool} ·{' '}
                {state.progress.latest.status}
              </small>
            )}
            {state && (
              <small>
                成功 {state.progress.completed} 次 · 失败{' '}
                {state.progress.failed} 次 · 子任务{' '}
                {state.progress.children.length} 个
              </small>
            )}
          </div>
          <div className="pet-chat" aria-live="polite">
            {!state?.messages.length && (
              <p className="pet-intro">
                可以问我“现在做到哪了”，或聊点别的。这里的对话独立保存，不会打断主助手。
                <br />
                真实模型模式下，问题和检索片段会发给你配置的模型服务。
              </p>
            )}
            {state?.messages.map((m) => (
              <article className={`pet-msg pet-msg-${m.role}`} key={m.id}>
                <span>
                  {m.role === 'user' ? '你' : '小伴'}
                  {m.simulated ? ' · 模拟' : ''}
                  {m.time
                    ? ' · ' +
                      new Date(m.time).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : ''}
                </span>
                <p>{m.text}</p>
                {(m.stale ||
                  (m.statusAtRead &&
                    m.statusAtRead !== state.progress.status)) && (
                  <small>本回答依据当时的任务状态；当前进展以顶部为准。</small>
                )}
                {!!m.sources?.length && (
                  <details>
                    <summary>查看历史证据 · {m.sources.length}</summary>
                    {m.sources.map((e) => (
                      <div className="pet-evidence" key={e.seq}>
                        <strong>
                          #{e.seq} · {e.type}
                        </strong>
                        <pre>{e.excerpt}</pre>
                        {sessionId && (
                          <EvidenceReader sessionId={sessionId} seq={e.seq} />
                        )}
                      </div>
                    ))}
                  </details>
                )}
                {m.role === 'assistant' && (
                  <button
                    className="pet-target-link"
                    onClick={() => {
                      setTarget('pet:' + m.id);
                      setNote('下方反馈将对应这条小伴回答');
                    }}
                  >
                    评价这条回答
                  </button>
                )}
              </article>
            ))}
            <div ref={end} />
          </div>
          {error && (
            <p className="pet-error" role="alert">
              {error}
            </p>
          )}
          <form
            className="pet-input"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              aria-label="问问小伴"
              placeholder="问问小伴…"
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              disabled={!sessionId}
            />
            {busy ? (
              <button
                type="button"
                aria-label="停止小伴回答"
                onClick={() =>
                  sessionId &&
                  request(sessionId, '/cancel', {}).catch((e) =>
                    setError(e.message),
                  )
                }
              >
                <Square size={15} />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="发送给小伴"
                disabled={!text.trim() || !sessionId}
              >
                <Send size={16} />
              </button>
            )}
          </form>
          <details className="pet-feedback" open={!!note}>
            <summary>这次表现怎么样？</summary>
            <div className="pet-feedback-row">
              <select
                aria-label="反馈对象"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="task">当前任务</option>
                {state?.progress.lastMessage && (
                  <option value="message">主助手最近回答</option>
                )}
                {state?.progress.latest && (
                  <option value="action">最近一次工具操作</option>
                )}
                {state?.messages
                  .filter((m) => m.role === 'assistant')
                  .map((m, i) => (
                    <option key={m.id} value={'pet:' + m.id}>
                      小伴回答 {i + 1}
                    </option>
                  ))}
              </select>
              <button
                aria-label="点赞"
                onClick={() => feedback('up')}
                disabled={!sessionId}
              >
                <ThumbsUp size={16} />
              </button>
              <button
                aria-label="点踩"
                onClick={() => feedback('down')}
                disabled={!sessionId}
              >
                <ThumbsDown size={16} />
              </button>
              <button
                aria-label="扔鸡蛋"
                onClick={() => feedback('egg')}
                disabled={!sessionId}
              >
                🥚
              </button>
            </div>
            <input
              aria-label="反馈原因"
              placeholder="哪里好，哪里不满意？（选填）"
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
            />
            <small>
              {note || '反馈只保存在本机；导出后可人工分析，不自动用于训练。'}
            </small>
          </details>
          <footer>
            <label>
              <input
                type="checkbox"
                checked={quiet}
                onChange={(e) => setQuiet(e.target.checked)}
              />{' '}
              安静陪伴
            </label>
            {confirmClear ? (
              <button
                onClick={async () => {
                  if (!sessionId) return;
                  try {
                    await request(sessionId, '/clear', {});
                    setConfirmClear(false);
                    setNote('');
                    await refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                确认清空本任务宠物记录
              </button>
            ) : (
              <button
                disabled={!sessionId || !!busy}
                onClick={() => setConfirmClear(true)}
              >
                清空记录
              </button>
            )}
            {!standalone && (
              <button
                aria-label="独立打开小伴"
                title="独立窗口；macOS 桌面浮窗请运行 npm run desktop"
                onClick={() =>
                  window.open(
                    '/pet/?session=' + encodeURIComponent(sessionId ?? ''),
                    'harness-pet',
                    'width=420,height=760',
                  )
                }
              >
                <ExternalLink size={14} />
              </button>
            )}
          </footer>
        </section>
      )}
      <div className="pet-dock">
        <div className="pet-quick-reactions" aria-label="随手表达心情">
          <button
            aria-label="不错，点赞"
            title="不错"
            onClick={() => void feedback('up', true)}
          >
            👍
          </button>
          <button
            aria-label="不满意，点踩"
            title="不满意"
            onClick={() => void feedback('down', true)}
          >
            👎
          </button>
          <button
            aria-label="做得不好，扔鸡蛋"
            title="做得不好"
            onClick={() => void feedback('egg', true)}
          >
            🥚
          </button>
          <button
            aria-label="太慢了"
            title="太慢了太慢了"
            onClick={() => void feedback('slow', true)}
          >
            🐢
          </button>
        </div>
        {standalone && (
          <button
            className="pet-drag"
            aria-label="拖动小伴"
            onPointerDown={() => native('drag')}
          >
            <GripHorizontal size={15} />
          </button>
        )}
        {!quiet && !open && (
          <button
            className="pet-bubble"
            onClick={() => {
              setOpen(true);
              native('expand');
            }}
          >
            {reaction === 'slow'
              ? '收到，等得有点久了'
              : reaction === 'egg'
                ? '这颗鸡蛋我收下了'
                : reaction === 'down'
                  ? '收到，不满意记下了'
                  : reaction === 'up'
                    ? '收到鼓励啦'
                    : error
                      ? '连接已断开'
                      : (state?.progress.label ?? '我在这里')}
          </button>
        )}
        <button
          className="pet-character"
          aria-label={open ? '小伴正在陪伴' : '打开小伴'}
          onClick={() => {
            setOpen((v) => !v);
            native(open ? 'collapse' : 'expand');
          }}
        >
          <PetFace
            key={reactionTick}
            mood={
              reaction === 'egg'
                ? 'egg'
                : reaction === 'up'
                  ? 'happy'
                  : reaction === 'down'
                    ? 'failed'
                    : reaction === 'slow'
                      ? 'waiting'
                      : (state?.progress.status ?? 'idle')
            }
          />
        </button>
      </div>
    </div>
  );
}

export function CompanionWidget(props: {
  sessionId: string | null;
  standalone?: boolean;
}) {
  const [open, setOpen] = useState(!!props.standalone);
  return (
    <CompanionPanel
      key={props.sessionId ?? 'no-task'}
      {...props}
      open={open}
      setOpen={setOpen}
    />
  );
}

function EvidenceReader({
  sessionId,
  seq,
}: {
  sessionId: string;
  seq: number;
}) {
  const [content, setContent] = useState(''),
    [next, setNext] = useState<number | null>(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function read() {
    if (next === null || busy) return;
    setBusy(true);
    try {
      const result = await request<{
        content: string;
        nextOffset: number | null;
      }>(sessionId, `/history?seq=${seq}&offset=${next}`);
      setContent((text) => text + result.content);
      setNext(result.nextOffset);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {content && <pre>{content}</pre>}
      {next !== null && (
        <button disabled={busy} onClick={read}>
          {content ? '继续读取原文' : '读取原始记录'}
        </button>
      )}
      {error && <small>{error}</small>}
    </div>
  );
}
