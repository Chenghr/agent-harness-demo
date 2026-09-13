'use client';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
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
import { MarkdownContent } from './markdown-content';
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
  mode?: 'task' | 'casual';
  model?: string;
  simulated?: boolean;
  time?: string;
  statusAtRead?: string;
  revision?: number;
  stale?: boolean;
  sources?: Evidence[];
};
type PetMood = 'computer' | 'happy' | 'jump' | 'sad' | 'wink';
type PetState = {
  progress: {
    title: string;
    status: string;
    label: string;
    pendingApprovals: number;
    completed: number;
    failed: number;
    model: string;
    revision: number;
    lastMessage: string | null;
    latest: { id: string; tool: string; status: string } | null;
    children: { id: string; goal: string; status: string }[];
  };
  presence?: {
    mood: PetMood;
    activity: 'working' | 'chatting' | 'resting';
    notice: {
      id: string;
      text: string;
      tone: 'working' | 'success' | 'attention' | 'danger' | 'neutral';
    };
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
  const bridge = w.webkit?.messageHandlers?.pet;
  if (!bridge) return false;
  bridge.postMessage(action);
  return true;
}
function hasNativeBridge() {
  const w = window as unknown as {
    webkit?: { messageHandlers?: { pet?: unknown } };
  };
  return !!w.webkit?.messageHandlers?.pet;
}
const petAssets: Record<PetMood, string> = {
  computer: '/assets/pet/robot-computer.png',
  happy: '/assets/pet/robot-happy.png',
  jump: '/assets/pet/robot-jump.png',
  sad: '/assets/pet/robot-sad.png',
  wink: '/assets/pet/robot-wink.png',
};
const eggComfortLines = [
  '啪！这颗我接住了，坏情绪先交给我。',
  '再来一颗也没关系，今天先别为难自己。',
  '都给我吧。等气消一点，我们再慢慢把事情做好。',
];
const slowComfortLines = [
  '收到，我替你催一催。你不用一直盯着，先伸个懒腰。',
  '确实等久了。时间不是你的错，我继续帮你守着进度。',
  '催办小乌龟已经出发，有新进展我会第一时间告诉你。',
];

function fallbackMood(status?: string): PetMood {
  if (
    ['thinking', 'running', 'waiting', 'verifying', 'cancelling'].includes(
      status ?? '',
    )
  )
    return 'computer';
  if (status === 'completed' || status === 'needs_review') return 'jump';
  if (status === 'failed' || status === 'interrupted') return 'sad';
  return 'wink';
}

export function PetFace({ mood = 'wink' }: { mood?: string }) {
  const resolved: PetMood = mood in petAssets ? (mood as PetMood) : 'wink';
  return (
    <span className={`pet-face pet-${resolved}`} aria-hidden="true">
      <span
        className="pet-sprite"
        style={{ backgroundImage: `url("${petAssets[resolved]}")` }}
      />
    </span>
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
  type PetPosition = { x: number; y: number };
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
    [confirmClear, setConfirmClear] = useState(false),
    [callout, setCallout] = useState(''),
    [btwMode, setBtwMode] = useState(false),
    [eggComfort, setEggComfort] = useState(''),
    [slowComfort, setSlowComfort] = useState(''),
    [position, setPosition] = useState<PetPosition | null>(null),
    [dragging, setDragging] = useState(false),
    [webPositioning, setWebPositioning] = useState(false),
    [panelPosition, setPanelPosition] = useState<PetPosition | null>(null),
    [steadyMood, setSteadyMood] = useState<PetMood | null>(null);
  const lifetime = useRef(new AbortController()),
    companionRef = useRef<HTMLDivElement>(null),
    panelRef = useRef<HTMLElement>(null),
    characterRef = useRef<HTMLButtonElement>(null),
    dragRef = useRef<{
      pointerId: number;
      startX: number;
      startY: number;
      originX: number;
      originY: number;
    } | null>(null),
    noticeSeen = useRef(''),
    calloutTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    eggComfortTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    slowComfortTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    steadyMoodTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    eggCount = useRef(0),
    slowCount = useRef(0),
    uiState = useRef({ quiet, open });
  const positionStorageKey = standalone
    ? 'yi-work-pet-position-standalone-v2'
    : 'yi-work-pet-position-workspace-v2';
  const clampPosition = useCallback((next: PetPosition): PetPosition => {
    const rect = companionRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 104;
    const height = rect?.height ?? 104;
    const margin = 8;
    return {
      x: Math.min(
        Math.max(margin, next.x),
        Math.max(margin, window.innerWidth - width - margin),
      ),
      y: Math.min(
        Math.max(margin, next.y),
        Math.max(margin, window.innerHeight - height - margin),
      ),
    };
  }, []);
  useEffect(() => {
    setWebPositioning(!hasNativeBridge());
  }, []);
  const placePanel = useCallback(() => {
    const panel = panelRef.current;
    const character = characterRef.current;
    if (!panel || !character) return;
    const panelRect = panel.getBoundingClientRect();
    const petRect = character.getBoundingClientRect();
    const margin = 10;
    const gap = 10;
    const maxX = Math.max(margin, window.innerWidth - panelRect.width - margin);
    const maxY = Math.max(margin, window.innerHeight - panelRect.height - margin);
    const x = Math.min(Math.max(margin, petRect.right - panelRect.width), maxX);
    const above = petRect.top - panelRect.height - gap;
    const below = petRect.bottom + gap;
    const y =
      above >= margin
        ? above
        : below + panelRect.height <= window.innerHeight - margin
          ? below
          : Math.min(Math.max(margin, above), maxY);
    setPanelPosition({ x, y });
  }, []);
  useLayoutEffect(() => {
    if (!open || !webPositioning) {
      setPanelPosition(null);
      return;
    }
    placePanel();
  }, [open, position, webPositioning, placePanel]);
  useEffect(() => {
    if (!open || !webPositioning) return;
    const update = () => placePanel();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open, webPositioning, placePanel]);
  useEffect(() => {
    if (hasNativeBridge()) return;
    try {
      const saved = JSON.parse(
        localStorage.getItem(positionStorageKey) ?? 'null',
      ) as PetPosition | null;
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y))
        requestAnimationFrame(() => setPosition(clampPosition(saved)));
    } catch {
      localStorage.removeItem(positionStorageKey);
    }
  }, [clampPosition, positionStorageKey]);
  useEffect(() => {
    if (!position) return;
    const frame = requestAnimationFrame(() =>
      setPosition((current) => (current ? clampPosition(current) : current)),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, clampPosition]);
  useEffect(() => {
    const keepVisible = () =>
      setPosition((current) => (current ? clampPosition(current) : current));
    window.addEventListener('resize', keepVisible);
    return () => window.removeEventListener('resize', keepVisible);
  }, [clampPosition]);
  function startDrag(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    if (native('drag')) return;
    const rect = companionRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const origin = clampPosition({ x: rect.left, y: rect.top });
    setPosition(origin);
    setDragging(true);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: origin.x,
      originY: origin.y,
    };
  }
  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPosition(
      clampPosition({
        x: drag.originX + event.clientX - drag.startX,
        y: drag.originY + event.clientY - drag.startY,
      }),
    );
  }
  function finishDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    setPosition((current) => {
      if (current) localStorage.setItem(positionStorageKey, JSON.stringify(current));
      return current;
    });
  }
  useEffect(() => {
    uiState.current = { quiet, open };
  }, [quiet, open]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      if (calloutTimer.current) clearTimeout(calloutTimer.current);
      if (eggComfortTimer.current) clearTimeout(eggComfortTimer.current);
      if (slowComfortTimer.current) clearTimeout(slowComfortTimer.current);
      if (steadyMoodTimer.current) clearTimeout(steadyMoodTimer.current);
    };
  }, []);
  const generation = useRef(0),
    end = useRef<HTMLDivElement>(null),
    inputRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const current = generation.current;
    const result = await request<PetState>(sessionId);
    if (current === generation.current) {
      setState(result);
      setError('');
      const notice = result.presence?.notice;
      if (notice && notice.id !== noticeSeen.current) {
        noticeSeen.current = notice.id;
        if (!uiState.current.quiet && !uiState.current.open) {
          setCallout(notice.text);
          if (calloutTimer.current) clearTimeout(calloutTimer.current);
          calloutTimer.current = setTimeout(() => setCallout(''), 6500);
        }
      }
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
  }, [state?.messages.length, open, btwMode]);
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
        { text: question, mode: btwMode ? 'casual' : 'task' },
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
    let comfort = '';
    if (quick) {
      setSteadyMood(
        state?.presence?.mood ?? fallbackMood(state?.progress.status),
      );
      if (steadyMoodTimer.current) clearTimeout(steadyMoodTimer.current);
      steadyMoodTimer.current = setTimeout(() => setSteadyMood(null), 6500);
    } else {
      setSteadyMood(null);
      if (steadyMoodTimer.current) clearTimeout(steadyMoodTimer.current);
    }
    if (kind === 'egg') {
      setSlowComfort('');
      if (slowComfortTimer.current) clearTimeout(slowComfortTimer.current);
      eggCount.current += 1;
      comfort =
        eggComfortLines[
          Math.min(eggCount.current - 1, eggComfortLines.length - 1)
        ];
      setEggComfort(comfort);
      if (eggComfortTimer.current) clearTimeout(eggComfortTimer.current);
      if (quick && !uiState.current.open) native('peek');
      eggComfortTimer.current = setTimeout(() => {
        setEggComfort('');
        if (!uiState.current.open) native('collapse');
      }, 6500);
    }
    if (kind === 'slow') {
      setEggComfort('');
      if (eggComfortTimer.current) clearTimeout(eggComfortTimer.current);
      slowCount.current += 1;
      comfort =
        slowComfortLines[
          Math.min(slowCount.current - 1, slowComfortLines.length - 1)
        ];
      setSlowComfort(comfort);
      if (slowComfortTimer.current) clearTimeout(slowComfortTimer.current);
      if (quick && !uiState.current.open) native('peek');
      slowComfortTimer.current = setTimeout(() => {
        setSlowComfort('');
        if (!uiState.current.open) native('collapse');
      }, 6500);
    }
    setReaction(kind);
    if (!quick) setReactionTick((v) => v + 1);
    setNote(
      kind === 'slow'
        ? `催办已收到。${comfort}`
        : kind === 'egg'
          ? `情绪已投递，不用解释。${comfort}`
          : kind === 'down'
            ? '收到。点踩会作为改进反馈，你也可以补充原因。'
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
        reason:
          kind === 'slow'
            ? '太慢了'
            : kind === 'egg'
              ? '情绪释放'
              : quick
                ? ''
                : reason,
      });
      setNote(
        kind === 'egg'
          ? `情绪已投递，不用解释。${comfort}`
          : kind === 'slow'
            ? `催办已收到。${comfort}`
            : '反馈已记录',
      );
      setReaction(kind);
      setReason('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function exportData() {
    if (!sessionId) return;
    if (new URLSearchParams(window.location.search).has('native')) {
      native('open');
      setNote('请在打开的网页小艺中导出记录');
      return;
    }
    try {
      const data = await request(sessionId, '/export');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `yi-work-pet-${sessionId}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const busy = sending || state?.busy;
  const mood: PetMood = steadyMood
    ? steadyMood
    : reaction === 'up'
      ? 'happy'
      : reaction === 'down' || reaction === 'egg'
        ? 'sad'
        : reaction === 'slow'
          ? 'computer'
          : (state?.presence?.mood ?? fallbackMood(state?.progress.status));
  const visibleMessages = (state?.messages ?? []).filter(
    (message) => (message.mode ?? 'task') === (btwMode ? 'casual' : 'task'),
  );
  function openBtwChat() {
    setBtwMode(true);
    setTarget('task');
    setText('');
    setOpen(true);
    native('expand');
    setTimeout(() => inputRef.current?.focus(), 0);
  }
  return (
    <div
      ref={companionRef}
      className={`companion ${standalone ? 'companion-standalone' : ''} ${webPositioning ? 'pet-web-positioning' : ''} ${dragging ? 'pet-dragging' : ''} pet-presence-${state?.presence?.activity ?? 'resting'} ${reaction ? `pet-reacting-${reaction}` : ''}`}
      style={
        position
          ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' }
          : undefined
      }
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      {open && (
        <section
          ref={panelRef}
          className={`pet-panel ${panelPosition ? 'pet-panel-positioned' : ''} ${btwMode ? 'pet-panel-btw' : ''}`}
          style={
            webPositioning && panelPosition
              ? { left: panelPosition.x, top: panelPosition.y }
              : undefined
          }
          aria-label={btwMode ? 'BTW 独立对话' : '小艺独立对话'}
        >
          <header>
            <span
              className="pet-panel-title"
              onPointerDown={startDrag}
              title="拖动小艺"
            >
              <PetFace mood={mood} />
              <span>
                <strong>{btwMode ? 'BTW · 随手问问' : '小艺'}</strong>
                <small>
                  {btwMode ? '独立对话，不打断主任务' : '你的 AI 工作搭子'}
                </small>
              </span>
            </span>
            <div>
              <button
                aria-label="导出宠物对话与反馈"
                title="导出对话与反馈"
                onClick={exportData}
                disabled={!sessionId}
              >
                <Download size={15} />
              </button>
              <button
                aria-label="收起小艺"
                onClick={() => {
                  setBtwMode(false);
                  setOpen(false);
                  native('collapse');
                }}
              >
                <Minus size={16} />
              </button>
              {standalone && !webPositioning && (
                <button
                  aria-label="退出小艺桌面宠物"
                  onClick={() => native('close')}
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </header>
          {btwMode ? (
            <div className="pet-btw-welcome">
              <strong>想顺便问点什么？</strong>
              <span>
                直接输入简单问题。这里的对话独立保存，不会进入主任务。
              </span>
            </div>
          ) : (
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
          )}
          <div className="pet-chat" aria-live="polite">
            {!visibleMessages.length && (
              <p className="pet-intro">
                {btwMode
                  ? '这是一个和主任务分开的轻量对话，适合顺手问一个简单问题。'
                  : '可以问我“现在做到哪了”，也可以通过 BTW 入口单独问个简单问题。这里的对话独立保存，不会打断主助手。'}
                <br />
                真实模型模式下，问题和检索片段会发给你配置的模型服务。
              </p>
            )}
            {visibleMessages.map((m) => (
              <article className={`pet-msg pet-msg-${m.role}`} key={m.id}>
                <span>
                  {m.role === 'user' ? '你' : '小艺'}
                  {m.simulated ? ' · 模拟' : ''}
                  {m.time
                    ? ' · ' +
                      new Date(m.time).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : ''}
                </span>
                <MarkdownContent
                  className="pet-message-content"
                  content={m.text}
                />
                {(m.stale ||
                  (m.statusAtRead &&
                    m.statusAtRead !== state?.progress.status)) && (
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
                      setNote('下方反馈将对应这条小艺回答');
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
          {(eggComfort || slowComfort) && (
            <div className="pet-emotion-note" role="status">
              <span aria-hidden="true">{eggComfort ? '🥚' : '🐢'}</span>
              <div>
                <strong>
                  {eggComfort ? '情绪已投递' : '小艺正在替你盯进度'}
                </strong>
                <p>{eggComfort || slowComfort}</p>
              </div>
            </div>
          )}
          <form
            className="pet-input"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              ref={inputRef}
              aria-label={btwMode ? 'BTW 简单问题' : '问问小艺'}
              placeholder={btwMode ? '顺便问个简单问题…' : '问问小艺当前进展…'}
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              disabled={!sessionId}
            />
            {busy ? (
              <button
                type="button"
                aria-label="停止小艺回答"
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
                aria-label="发送给小艺"
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
                {visibleMessages
                  .filter((m) => m.role === 'assistant')
                  .map((m, i) => (
                    <option key={m.id} value={'pet:' + m.id}>
                      小艺回答 {i + 1}
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
                title="结果不满意，留下改进反馈"
                onClick={() => feedback('down')}
                disabled={!sessionId}
              >
                <ThumbsDown size={16} />
              </button>
              <button
                aria-label="扔鸡蛋，释放情绪"
                title="不用解释，先扔颗蛋消消气"
                onClick={() => feedback('egg')}
                disabled={!sessionId}
              >
                🥚
              </button>
              <button
                aria-label="催一催，太慢了"
                title="等得有点久，让小艺替你盯进度"
                onClick={() => feedback('slow')}
                disabled={!sessionId}
              >
                🐢
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
            <p className="pet-feedback-hint">
              <span>👎 帮助改进结果</span>
              <span>🥚 只管释放情绪</span>
              <span>🐢 替你催办盯进度</span>
            </p>
          </details>
          <footer>
            <label>
              <input
                type="checkbox"
                checked={quiet}
                onChange={(e) => {
                  setQuiet(e.target.checked);
                }}
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
                aria-label="独立打开小艺"
                title="独立窗口；macOS 桌面浮窗请运行 npm run desktop"
                onClick={() =>
                  window.open(
                    '/pet/?session=' + encodeURIComponent(sessionId ?? ''),
                    'yi-work-pet',
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
        <div className="pet-quick-reactions" aria-label="快捷入口与情绪反馈">
          <button
            className="pet-quick-btw"
            aria-label="BTW，单独问个简单问题"
            title="打开独立轻量对话，不打断主任务"
            onClick={openBtwChat}
            disabled={!sessionId}
          >
            BTW
          </button>
          <button
            aria-label="不错，点赞"
            title="不错"
            onClick={() => void feedback('up', true)}
          >
            👍
          </button>
          <button
            aria-label="不满意，点踩"
            title="结果不满意，留下改进反馈"
            onClick={() => void feedback('down', true)}
          >
            👎
          </button>
          <button
            className="pet-quick-egg"
            aria-label="扔鸡蛋，释放情绪"
            title="不想解释，先扔颗蛋消消气"
            onClick={() => void feedback('egg', true)}
          >
            🥚
          </button>
          <button
            className="pet-quick-slow"
            aria-label="催一催，太慢了"
            title="等得有点久，让小艺替你盯进度"
            onClick={() => void feedback('slow', true)}
          >
            🐢
          </button>
        </div>
        <button
          className="pet-drag"
          aria-label="拖动小艺"
          title="按住拖动，位置会自动保存"
          onPointerDown={startDrag}
        >
          <GripHorizontal size={15} />
        </button>
        {!quiet && !open && (
          <button
            className={`pet-bubble ${eggComfort ? 'pet-bubble-egg' : ''} ${slowComfort ? 'pet-bubble-slow' : ''}`}
            onClick={() => {
              setBtwMode(false);
              setText('');
              setOpen(true);
              native('expand');
            }}
          >
            {slowComfort
              ? slowComfort
              : eggComfort
                ? eggComfort
                : reaction === 'down'
                  ? '收到，不满意记下了'
                  : reaction === 'up'
                    ? '收到鼓励啦'
                    : callout
                      ? callout
                      : error
                        ? '连接已断开'
                        : (state?.progress.label ?? '我在这里')}
          </button>
        )}
        <button
          ref={characterRef}
          className="pet-character"
          aria-label={open ? '小艺正在陪伴' : '打开小艺'}
          onClick={() => {
            if (!open) {
              setBtwMode(false);
              setText('');
            }
            setOpen((v) => !v);
            native(open ? 'collapse' : 'expand');
          }}
        >
          <PetFace key={reactionTick} mood={mood} />
          {reaction === 'egg' && (
            <>
              <span className="pet-egg-flight" aria-hidden="true">
                🥚
              </span>
              <span className="pet-egg-release" aria-hidden="true">
                情绪 −1
              </span>
            </>
          )}
          {reaction === 'slow' && (
            <>
              <span className="pet-slow-runner" aria-hidden="true">
                🐢
              </span>
              <span className="pet-slow-watch" aria-hidden="true">
                替你盯着
              </span>
            </>
          )}
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
