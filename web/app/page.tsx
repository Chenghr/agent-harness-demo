'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RuntimeSettings,
  WorkspaceChooser,
  type Workspace,
} from './components/runtime-settings';
import { WorkspaceChanges } from './components/workspace-changes';
import { CompanionWidget } from './components/companion';
import { CompletionReview } from './components/completion-review';
import type { CompletionRecord } from '../../server/runtime/contracts.ts';
import {
  Activity,
  ArrowRight,
  BookOpen,
  Box,
  Check,
  ChevronRight,
  Circle,
  Cpu,
  FileText,
  GitBranch,
  Layers,
  LoaderCircle,
  MessageSquare,
  Pause,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Workflow,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar';

type Profile = {
  id: string;
  label: string;
  simulated: boolean;
  configured: boolean;
  contextWindow: number;
  protocol: string;
};
type Scenario = { id: string; name: string; subtitle: string; prompt: string };
type Agent = {
  id: string;
  parentId: string | null;
  goal: string;
  status: string;
  model: string;
  epoch: number;
  loadedTools: string[];
  loadedSkills: string[];
  result?: string;
  completion?: CompletionRecord;
  delegation?: {
    type: string;
    mode: string;
    expectedOutput: string;
    reason: string;
    materials: { path: string }[];
    workspaceMode: string;
    permissionMode: string;
    instructions: string;
    tools: string[];
    version: string;
  };
  output?: { resultId: string; cleanup: string };
  stale?: boolean;
  context?: {
    tokens: number;
    budget: number;
    available: number;
    reserve: number;
    margin: number;
    breakdown?: Record<string, number>;
    summary: string;
    compactions: number;
    historyUnits: number;
  };
};
type Action = {
  id: string;
  agentId: string;
  tool: string;
  status: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  duration?: number;
};
type Approval = {
  reason?: string;
  scope?: string;
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: string;
  agentId: string;
};
type Artifact = { id: string; name: string; bytes: number; content?: string };
type EventItem = {
  id: string;
  seq: number;
  type: string;
  time: string;
  agentId: string;
  data: Record<string, unknown>;
};
type Session = {
  workspaceId?: string;
  workspace?: string;
  permissionMode?: string;
  id: string;
  title: string;
  status: string;
  scenario: string;
  model: string;
  mainAgentId: string;
  closing: boolean;
  agents: Record<string, Agent>;
  chat: {
    id: string;
    role: string;
    text: string;
    time: string;
    model?: string;
  }[];
  actions: Action[];
  approvals: Approval[];
  artifacts: Artifact[];
  grants: { id: string; tool: string; path: string }[];
  readOnly: boolean;
  acceptance?: { description: string; requirementRevision: number };
  revision: number;
  stats: {
    toolCalls: number;
    succeeded: number;
    failed: number;
    cancelled: number;
  };
  resources: { id: string; pid: number; status: string; agentId: string }[];
  handoffs: { from: string; to: string; time: string; facts: unknown }[];
  events: EventItem[];
};
type CatalogItem = {
  name: string;
  title: string;
  description: string;
  kind: string;
  category: string;
  simulated: boolean;
  source: string;
  content?: string;
  parameters?: unknown;
};
type Config = {
  workspaces?: Workspace[];
  models: Profile[];
  assistants?: {
    name: string;
    description: string;
    model: string;
    workspaceMode: string;
  }[];
  scenarios: Scenario[];
  counts: {
    tools: number;
    skills: number;
    realTools: number;
    fixtureTools: number;
    authoredSkills: number;
    generatedSkills: number;
  };
  version: string;
};
const states: Record<string, string> = {
  idle: '就绪',
  running: '运行中',
  thinking: '生成中',
  verifying: '检查成果',
  needs_review: '待验收',
  waiting: '等待后台',
  awaiting_approval: '等待授权',
  compacting: '压缩中',
  cancelling: '正在停止',
  cancelled: '已停止',
  completed: '已完成',
  succeeded: '成功',
  failed: '失败',
  denied: '已拒绝',
  interrupted: '运行中断',
  queued: '排队中',
  pending: '待确认',
};
const activeStates = [
  'running',
  'thinking',
  'verifying',
  'waiting',
  'awaiting_approval',
  'compacting',
  'cancelling',
];
const icons = [Workflow, Pause, Layers, ShieldCheck, Activity];
const eventLabels: Record<string, string> = {
  'session.created': '任务已创建',
  'agent.started': 'Agent 开始执行',
  'agent.completed': 'Agent 工作完成',
  'agent.spawned': '后台任务已创建',
  'agent.cancelled': '后台任务已停止',
  'agent.failed': 'Agent 执行失败',
  'tool.started': '工具开始执行',
  'tool.succeeded': '工具执行完成',
  'tool.failed': '工具执行失败',
  'tool.cancelled': '工具已取消',
  'tool.unloaded': '工具定义已卸载',
  'skill.unloaded': 'Skill 已卸载',
  'tool.loaded': '工具定义已加载',
  'skill.loaded': 'Skill 已加载',
  'skill.warning': 'Skill 来源提示',
  'context.compacting': '正在压缩上下文',
  'context.compacted': '上下文压缩完成',
  'context.discarded': '旧摘要已丢弃',
  'model.switched': '模型交接完成',
  'model.switch_requested': '已请求模型切换',
  'process.started': '本地进程已启动',
  'process.exited': '进程已退出并回收',
  'approval.requested': '等待用户授权',
  'approval.resolved': '授权已处理',
  'session.steered': '用户改变任务方向',
  'session.stopped': '任务已停止',
  'session.completed': '任务已结束',
  'session.needs_review': '成果待验收',
  'agent.needs_review': '后台结果待核实',
  'completion.started': '开始检查成果',
  'completion.checked': '成果检查结果',
  'completion.retry': '根据检查结果继续修改',
  'completion.stale': '要求或成果变化，重新检查',
  'model.stale': '旧轮次输出被隔离',
};
async function api<T>(
  route: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `/api${route}`,
    body === undefined
      ? { signal }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        },
  );
  const data: unknown = await response.json();
  if (!response.ok) {
    const error =
      data && typeof data === 'object' && 'error' in data ? data.error : null;
    throw new Error(
      error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : '请求失败',
    );
  }
  // The server owns these DTOs; this is the single JSON-to-TypeScript boundary.
  return data as T;
}
const pretty = (v: unknown) =>
  typeof v === 'string' ? v : JSON.stringify(v, null, 2);
const clock = (t: string) =>
  new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
function Status({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`status status-${status}`}>
      <span />
      {label ?? states[status] ?? status}
    </span>
  );
}
function Empty({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="panel-empty">
      <div>{icon}</div>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

export default function Home() {
  const [config, setConfig] = useState<Config | null>(null);
  const [sessions, setSessions] = useState<
    { id: string; title: string; status: string; workspaceId?: string }[]
  >([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState('demo-balanced');
  const [mode, setMode] = useState('steer');
  const [tab, setTab] = useState('agents');
  const [busy, setBusy] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState('');
  const [permissionMode, setPermissionMode] = useState('ask');
  const [changesOpen, setChangesOpen] = useState(false);
  const [fullPermissionOpen, setFullPermissionOpen] = useState(false);
  const refreshConfig = () =>
    api<Config>('/config').then(setConfig).catch(fail);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('tool');
  const [catalogPage, setCatalogPage] = useState(0);
  const [catalog, setCatalog] = useState<{
    total: number;
    items: CatalogItem[];
  }>({
    total: 0,
    items: [],
  });
  const [catalogDetail, setCatalogDetail] = useState<CatalogItem | null>(null);
  const [detail, setDetail] = useState<{ title: string; body: string } | null>(
    null,
  );
  const [streaming, setStreaming] = useState('');
  const [events, setEvents] = useState<EventItem[]>([]);
  const [childDraft, setChildDraft] = useState('');
  const [childType, setChildType] = useState('general');
  const [childFiles, setChildFiles] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const refreshList = useCallback(
    () => api<typeof sessions>('/sessions').then(setSessions),
    [],
  );
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  useEffect(() => {
    api<Config>('/config').then(setConfig).catch(fail);
    refreshList().catch(fail);
  }, [refreshList]);
  useEffect(() => {
    if (!selected) return;
    const source = new EventSource(`/api/sessions/${selected}/stream`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('state', (e) => {
      const s = JSON.parse(e.data) as Session;
      setSession(s);
      setModel(s.model);
    });
    source.addEventListener('event', (e) => {
      const event = JSON.parse(e.data) as EventItem;
      if (event.type === 'model.delta' && event.agentId === 'main')
        setStreaming((t) => t + String(event.data.text));
      if (
        event.type === 'model.finished' ||
        event.type === 'model.stale' ||
        event.type === 'session.steered' ||
        event.type === 'session.stopped'
      )
        setStreaming('');
      if (
        !['model.delta', 'context.unit', 'process.output'].includes(event.type)
      )
        setEvents((items) =>
          [...items.filter((i) => i.id !== event.id), event].slice(-180),
        );
    });
    return () => {
      source.close();
      setConnected(false);
    };
  }, [selected]);
  const sessionStatus = session?.status;
  useEffect(() => {
    if (selected) refreshList().catch(fail);
  }, [sessionStatus, selected, refreshList]);
  useEffect(() => {
    if (autoScroll)
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [session?.chat.length, streaming, session?.approvals.length, autoScroll]);
  useEffect(() => {
    if (!catalogOpen) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        api<{ total: number; items: CatalogItem[] }>(
          `/catalog?kind=${kind}&q=${encodeURIComponent(query)}&offset=${catalogPage * 20}`,
          undefined,
          controller.signal,
        )
          .then(setCatalog)
          .catch((e) => {
            if (e.name !== 'AbortError') fail(e);
          }),
      180,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, kind, catalogOpen, catalogPage]);
  function chooseSession(id: string | null) {
    if (id === selected) return;
    setSession(null);
    setEvents([]);
    setStreaming('');
    setConnected(false);
    setSelected(id);
    if (id)
      setWorkspaceId(sessions.find((s) => s.id === id)?.workspaceId ?? '');
    void api('/companion/focus', { sessionId: id }).catch(fail);
  }
  async function create(scenario = 'full', prompt = draft) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const s = await api<Session>('/sessions', {
        model,
        scenario,
        prompt,
        workspaceId:
          scenario === 'custom' ? workspaceId || undefined : undefined,
        permissionMode,
      });
      chooseSession(s.id);
      setDraft('');
      await refreshList();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!draft.trim() || busy) return;
    if (!selected) return create('custom', draft);
    setBusy(true);
    setError('');
    try {
      await api(`/sessions/${selected}/messages`, { text: draft, mode });
      setDraft('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function command(route: string, body: unknown = {}) {
    if (!selected) return;
    try {
      await api(`/sessions/${selected}/${route}`, body);
    } catch (e) {
      fail(e);
    }
  }
  async function changeModel(value: string | null) {
    if (!value) return;
    if (!selected) {
      setModel(value);
      return;
    }
    await command('model', { model: value });
  }
  const main = session?.agents[session.mainAgentId];
  const active = !!session && activeStates.includes(session.status);
  const context = main?.context;
  const profile = config?.models.find((p) => p.id === model);
  const approvals =
    session?.approvals.filter((a) => a.status === 'pending') ?? [];
  const visibleEvents = events.length
    ? events
    : (session?.events ?? [])
        .filter(
          (e) =>
            !['context.unit', 'model.delta', 'process.output'].includes(e.type),
        )
        .slice(-100);

  return (
    <SidebarProvider
      style={{ '--sidebar-width': '224px' } as React.CSSProperties}
    >
      <Sidebar collapsible="none" className="lab-sidebar">
        <SidebarHeader className="brand">
          <div className="brand-symbol">
            <Workflow size={23} />
          </div>
          <div>
            Harness<span>工作空间</span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <Button
              className="new-task"
              onClick={() => {
                chooseSession(null);
                setDraft('');
              }}
            >
              <Plus size={17} />
              新建任务<span>＋</span>
            </Button>
          </SidebarGroup>
          <SidebarGroup>
            <div className="nav-label">工作台</div>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={!catalogOpen}
                  onClick={() => setCatalogOpen(false)}
                >
                  <MessageSquare />
                  <span>对话与执行</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => {
                    window.location.href = '/capabilities/';
                  }}
                >
                  <Box />
                  <span>能力管理</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setCatalogOpen(true)}>
                  <Box />
                  <span>快速加载</span>
                  <span className="nav-count">
                    {config ? config.counts.tools + config.counts.skills : '—'}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup>
            <div className="nav-label">
              最近任务 <span>{sessions.length}</span>
            </div>
            <SidebarMenu>
              {!sessions.length && (
                <p className="quiet empty-history">任务记录将保存在本机。</p>
              )}
              {sessions.slice(0, 20).map((s) => (
                <SidebarMenuItem key={s.id}>
                  <SidebarMenuButton
                    className="session-link"
                    isActive={selected === s.id}
                    onClick={() => chooseSession(s.id)}
                  >
                    <span
                      className={`tiny-dot ${activeStates.includes(s.status) ? 'lit' : ''}`}
                    />
                    <span>{s.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="local-note">
            <ShieldCheck size={16} />
            <span>本地运行 · 文件与对话保存在本机</span>
          </div>
          <Button
            variant="ghost"
            className="settings-link"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={16} />
            模型与运行设置
          </Button>
          <div className="version">
            HARNESS LAB <span>v1.0</span>
          </div>
        </SidebarFooter>
      </Sidebar>
      <CompanionWidget sessionId={selected} />
      <main className="lab-main">
        <header className="topbar">
          <Button
            className="mobile-new-task"
            size="icon"
            variant="ghost"
            aria-label="新建任务"
            onClick={() => {
              chooseSession(null);
              setDraft('');
            }}
          >
            <Plus size={17} />
          </Button>
          <div className="breadcrumb">
            工作台
            <ChevronRight size={14} />
            <strong>{session?.title ?? '新建任务'}</strong>
          </div>
          <div className="topbar-right">
            <Button
              className="compact-settings"
              size="sm"
              variant="ghost"
              aria-label="模型设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={16} />
            </Button>
            {session?.workspaceId && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setChangesOpen(true)}
              >
                <GitBranch size={14} />
                修改记录
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setInspectOpen((v) => !v)}
              aria-expanded={inspectOpen}
            >
              <Activity size={14} /> {inspectOpen ? '收起详情' : '运行详情'}
            </Button>
            {session && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTab('files');
                  setInspectOpen(true);
                }}
              >
                <FileText size={14} />
                成果
              </Button>
            )}
            <span className="local-indicator">
              <i className={connected || !selected ? 'online' : ''} />
              {selected ? (connected ? '实时连接' : '重新连接中') : '本地模式'}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCatalogOpen(true)}
            >
              <Box size={14} />
              能力目录
            </Button>
          </div>
        </header>
        <div className="compact-session-switcher">
          <select
            aria-label="切换对话"
            value={selected ?? ''}
            onChange={(e) => chooseSession(e.target.value || null)}
          >
            <option value="">新建任务</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <button onClick={() => setSettingsOpen(true)}>模型与 API</button>
        </div>
        <WorkspaceChooser
          items={config?.workspaces ?? []}
          value={session ? (session.workspaceId ?? '') : workspaceId}
          onAdded={refreshConfig}
          onSelect={(id) => {
            setWorkspaceId(id);
            chooseSession(null);
          }}
        />
        <div className={`workbench ${inspectOpen ? '' : 'focus-workbench'}`}>
          <section className="conversation" aria-label="对话工作区">
            <div className="conversation-toolbar">
              <span className="section-eyebrow">
                <Terminal size={15} />
                任务对话
              </span>
              <div className="toolbar-actions">
                {session && <Status status={session.status} />}
                <span className="mode-badge">
                  {profile?.simulated === false ? '真实模型' : '模拟演示'}
                </span>
              </div>
            </div>
            <div
              className="chat-scroll"
              onScroll={(e) => {
                const el = e.currentTarget;
                setAutoScroll(
                  el.scrollHeight - el.scrollTop - el.clientHeight < 120,
                );
              }}
            >
              {!session && !selected && (
                <div className="welcome">
                  <div className="welcome-mark">
                    <Workflow size={32} />
                  </div>
                  <p className="eyebrow">把事情交给助手，进展留在这里</p>
                  <h1>今天想完成什么？</h1>
                  <p className="welcome-description">
                    描述你要做的事。过程中可以随时补充要求，完成后在这里查看成果。
                  </p>
                  <button
                    className="examples-toggle"
                    onClick={() => setExamplesOpen((v) => !v)}
                    aria-expanded={examplesOpen}
                  >
                    试试一个演示任务 <ChevronRight size={14} />
                  </button>
                  {examplesOpen && (
                    <div className="scenario-grid">
                      {config?.scenarios.map((s, i) => {
                        const Icon = icons[i] ?? Workflow;
                        return (
                          <button
                            key={s.id}
                            className={`scenario-card ${i === 0 ? 'featured' : ''}`}
                            onClick={() => create(s.id, s.prompt)}
                            disabled={busy}
                          >
                            <Icon size={19} />
                            <div>
                              <strong>{s.name}</strong>
                              <span>{s.subtitle}</span>
                            </div>
                            <ArrowRight size={16} />
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <p className="demo-footnote">
                    <Circle size={9} />
                    模拟模型采用可复现脚本；工具、文件操作与进程管理真实执行。
                  </p>
                </div>
              )}
              {selected && !session && (
                <div className="loading-state">
                  <LoaderCircle className="spin" />
                  正在读取任务…
                </div>
              )}
              {session?.chat.map((m) => (
                <article className={`message message-${m.role}`} key={m.id}>
                  <div className="message-avatar">
                    {m.role === 'user' ? (
                      '你'
                    ) : m.role === 'system' ? (
                      <Activity size={15} />
                    ) : (
                      <Workflow size={18} />
                    )}
                  </div>
                  <div className="message-body">
                    <div className="message-meta">
                      <strong>
                        {m.role === 'user'
                          ? '你'
                          : m.role === 'system'
                            ? '运行时'
                            : '主助手'}
                      </strong>
                      <span>
                        {m.model &&
                          config?.models.find((p) => p.id === m.model)?.label}
                      </span>
                      <time>{clock(m.time)}</time>
                    </div>
                    <div className="message-text">{m.text}</div>
                  </div>
                </article>
              ))}
              {streaming && (
                <article className="message">
                  <div className="message-avatar">
                    <Workflow size={18} />
                  </div>
                  <div className="message-body">
                    <div className="message-meta">
                      <strong>主助手</strong>
                      <span>生成中</span>
                    </div>
                    <div className="message-text">
                      {streaming}
                      <span className="cursor" />
                    </div>
                  </div>
                </article>
              )}
              {active && !streaming && (
                <div className="working-line">
                  <span className="pulse-dot" />
                  {approvals.length
                    ? '操作需要你的授权'
                    : session?.status === 'cancelling'
                      ? '正在停止并回收任务资源…'
                      : '运行时正在推进任务…'}
                  <span>{session?.stats.toolCalls ?? 0} 次调用</span>
                </div>
              )}
              {approvals.map((a) => (
                <div className="approval-card" key={a.id}>
                  {a.reason && <p>{a.reason}</p>}
                  <div className="approval-heading">
                    <ShieldCheck size={19} />
                    <strong>执行前，请确认这次修改</strong>
                  </div>
                  <p>
                    {a.agentId === 'main'
                      ? '主助手'
                      : `子助手：${session?.agents[a.agentId]?.goal ?? a.agentId}`}{' '}
                    · {a.tool} · {pretty(a.args.path ?? '')}
                  </p>
                  <pre>
                    {(typeof a.args.content === 'string'
                      ? a.args.content
                      : pretty(a.args)
                    ).slice(0, 1600)}
                  </pre>
                  {(typeof a.args.content === 'string'
                    ? a.args.content
                    : pretty(a.args)
                  ).length > 1600 && (
                    <button
                      className="text-link"
                      onClick={() =>
                        setDetail({
                          title: '完整操作内容',
                          body:
                            typeof a.args.content === 'string'
                              ? a.args.content
                              : pretty(a.args),
                        })
                      }
                    >
                      查看完整内容
                    </button>
                  )}
                  <div className="approval-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        command('approvals/' + a.id, { decision: 'deny' })
                      }
                    >
                      拒绝
                    </Button>
                    {a.scope !== 'once' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          command('approvals/' + a.id, { decision: 'task' })
                        }
                      >
                        允许此助手继续修改此文件
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() =>
                        command('approvals/' + a.id, { decision: 'once' })
                      }
                    >
                      <Check size={14} />
                      仅本次允许
                    </Button>
                  </div>
                </div>
              ))}
              {session && (
                <CompletionReview
                  key={`${session.id}-${main?.completion?.id ?? 'checking'}`}
                  status={session.status}
                  completion={main?.completion}
                  criteria={
                    session.acceptance?.requirementRevision === session.revision
                      ? session.acceptance.description
                      : '要求已改变或尚未配置自动标准，需要验收当前成果。'
                  }
                  onReview={async (decision) => {
                    const next = await api<Session>(
                      `/sessions/${session.id}/review`,
                      decision,
                    );
                    setSession(next);
                    await refreshList();
                  }}
                />
              )}
              <div ref={endRef} />
            </div>
            {error && (
              <div className="error-bar" role="alert">
                <span>{error}</span>
                <button onClick={() => setError('')} aria-label="关闭错误">
                  <X size={16} />
                </button>
              </div>
            )}
            <div className="composer-wrap">
              <div className="composer">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={
                    active
                      ? '补充要求，或输入新的方向…'
                      : '输入任务，例如：根据已有规则检查隐私实体标注…'
                  }
                  aria-label="任务消息"
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-controls">
                  <select
                    className="permission-control"
                    aria-label="权限模式"
                    disabled={session ? !session.workspaceId : !workspaceId}
                    title="选择用户工作区后可配置权限；教学示例保持原有审批"
                    value={session?.permissionMode ?? permissionMode}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (next === 'full') {
                        setFullPermissionOpen(true);
                        return;
                      }
                      if (selected) void command('permissions', { mode: next });
                      else setPermissionMode(next);
                    }}
                  >
                    <option value="ask">请求批准</option>
                    <option value="review">帮我批准</option>
                    <option value="full">完全访问权限</option>
                  </select>
                  <Select value={model} onValueChange={changeModel}>
                    <SelectTrigger
                      className="model-select"
                      aria-label="选择模型"
                    >
                      <Cpu size={14} />
                      <SelectValue>
                        {config?.models.find((m) => m.id === model)?.label ??
                          'Demo · 标准'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {config?.models.map((m) => (
                        <SelectItem
                          key={m.id}
                          value={m.id}
                          disabled={!m.configured}
                        >
                          {m.label}
                          {!m.configured ? ' · 未配置' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="send-controls">
                    {active && (
                      <Select
                        value={mode}
                        onValueChange={(v) => v && setMode(v)}
                      >
                        <SelectTrigger
                          className="mode-select"
                          aria-label="消息处理方式"
                        >
                          <SelectValue>
                            {mode === 'steer' ? '立即改方向' : '下一步补充'}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="steer">立即改方向</SelectItem>
                          <SelectItem value="append">下一步补充</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    {active && (
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={() => command('stop')}
                        aria-label="停止整个任务"
                        disabled={session?.status === 'cancelling'}
                      >
                        <Square size={15} />
                      </Button>
                    )}
                    <Button
                      className="send-button"
                      size="icon"
                      disabled={!draft.trim() || busy}
                      onClick={send}
                      aria-label="发送消息"
                    >
                      {busy ? (
                        <LoaderCircle className="spin" size={17} />
                      ) : (
                        <ArrowRight size={19} />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="composer-note">
                <span>Enter 发送 · Shift + Enter 换行</span>
                <span>随时补充要求</span>
              </div>
            </div>
          </section>
          {inspectOpen && (
            <aside className="inspector" aria-label="运行观察面板">
              <div className="inspector-heading">
                <span>
                  <Activity size={16} />
                  运行观察
                </span>
                <button
                  aria-label="收起运行详情"
                  onClick={() => setInspectOpen(false)}
                >
                  <X size={15} />
                </button>
              </div>
              <div className="metric-strip">
                <div>
                  <strong>{session?.stats.toolCalls ?? 0}</strong>
                  <span>工具调用</span>
                </div>
                <div>
                  <strong>
                    {
                      Object.values(session?.agents ?? {}).filter(
                        (a) => a.parentId && activeStates.includes(a.status),
                      ).length
                    }
                  </strong>
                  <span>后台活动</span>
                </div>
                <div>
                  <strong>{context?.compactions ?? 0}</strong>
                  <span>上下文压缩</span>
                </div>
              </div>
              <Tabs
                value={tab}
                onValueChange={setTab}
                className="inspector-tabs"
              >
                <TabsList variant="line">
                  <TabsTrigger value="agents">任务树</TabsTrigger>
                  <TabsTrigger value="tools">工具</TabsTrigger>
                  <TabsTrigger value="context">上下文</TabsTrigger>
                  <TabsTrigger value="events">事件</TabsTrigger>
                  <TabsTrigger value="files">产物</TabsTrigger>
                </TabsList>
                <TabsContent value="agents">
                  <div className="panel-label">
                    AGENT TREE{' '}
                    <span>
                      {Object.keys(session?.agents ?? {}).length} 个节点
                    </span>
                  </div>
                  {!session ? (
                    <Empty
                      icon={<GitBranch />}
                      title="任务尚未开始"
                      text="主助手 与后台任务会在这里形成有归属的任务树。"
                    />
                  ) : (
                    <>
                      <div className="agent-tree">
                        {Object.values(session.agents).map((a) => (
                          <div
                            className={`agent-card ${a.parentId ? 'child-agent' : ''}`}
                            key={a.id}
                          >
                            <div className="agent-card-top">
                              <div className="agent-icon">
                                <Cpu size={17} />
                              </div>
                              <strong>
                                {a.parentId
                                  ? ({
                                      general: '通用助手',
                                      analysis: '分析助手',
                                      review: '检查助手',
                                    }[a.delegation?.type ?? 'general'] ??
                                    a.delegation?.type)
                                  : '主助手'}
                              </strong>
                              <Status
                                status={a.status}
                                label={
                                  a.parentId && a.status === 'needs_review'
                                    ? '待核实'
                                    : undefined
                                }
                              />
                            </div>
                            <p>{a.goal}</p>
                            <div className="agent-meta">
                              <span>
                                {config?.models.find((m) => m.id === a.model)
                                  ?.label ?? a.model}
                              </span>
                              <span>轮次 {a.epoch}</span>
                              {a.delegation && (
                                <span>
                                  {a.delegation.mode === 'foreground'
                                    ? '等待结果'
                                    : '后台执行'}
                                </span>
                              )}
                            </div>
                            {a.delegation && (
                              <details className="assistant-details">
                                <summary>
                                  材料与工作范围{a.stale ? ' · 依据已变化' : ''}
                                </summary>
                                <p>
                                  材料：
                                  {a.delegation.materials
                                    .map((m) => m.path)
                                    .join('、') || '未分配文件'}
                                </p>
                                <p>
                                  {a.delegation.workspaceMode === 'outputs'
                                    ? '读取分配材料，可申请在自己的 outputs 目录生成文件。'
                                    : '只读检查，不能修改文件。'}
                                </p>
                                {a.delegation.expectedOutput && (
                                  <p>需要返回：{a.delegation.expectedOutput}</p>
                                )}
                                {a.delegation.reason && (
                                  <p>分工原因：{a.delegation.reason}</p>
                                )}
                                <p>{a.delegation.instructions}</p>
                                {a.output && (
                                  <p>
                                    {a.output.cleanup === 'released'
                                      ? '受管理资源已回收'
                                      : '资源回收尚未确认'}
                                  </p>
                                )}
                              </details>
                            )}
                            {a.result && (
                              <button
                                className="text-link"
                                onClick={() =>
                                  setDetail({
                                    title: 'Agent 结果',
                                    body: a.result!,
                                  })
                                }
                              >
                                查看结果
                                <ChevronRight size={13} />
                              </button>
                            )}
                            {a.parentId && activeStates.includes(a.status) && (
                              <div className="child-actions">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    command('agents/' + a.id + '/message', {
                                      message: childDraft,
                                    })
                                  }
                                >
                                  发送下方补充
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    command('agents/' + a.id + '/message', {
                                      message: childDraft,
                                      mode: 'steer',
                                    })
                                  }
                                >
                                  按新说明继续
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    command('agents/' + a.id + '/cancel')
                                  }
                                >
                                  取消
                                </Button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      {!session.closing && active && (
                        <div className="spawn-box">
                          <select
                            aria-label="子助手类型"
                            value={childType}
                            onChange={(e) => setChildType(e.target.value)}
                          >
                            {(config?.assistants ?? [{ name: 'general' }]).map(
                              (item) => (
                                <option key={item.name} value={item.name}>
                                  {{
                                    general: '通用助手',
                                    analysis: '分析助手',
                                    review: '检查助手',
                                  }[item.name] ?? item.name}
                                </option>
                              ),
                            )}
                          </select>
                          <Input
                            aria-label="后台任务目标或补充"
                            placeholder="这次需要助手完成什么？"
                            value={childDraft}
                            onChange={(e) => setChildDraft(e.target.value)}
                          />
                          <Input
                            aria-label="分配给子助手的文件"
                            placeholder="文件路径，逗号分隔；留空不分配文件"
                            value={childFiles}
                            onChange={(e) => setChildFiles(e.target.value)}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!childDraft.trim()}
                            onClick={() =>
                              command('agents', {
                                goal: childDraft,
                                type: childType,
                                files: childFiles
                                  .split(/[,，]/)
                                  .map((f) => f.trim())
                                  .filter(Boolean),
                                mode: 'background',
                              })
                            }
                          >
                            <Plus size={14} />
                            创建后台任务
                          </Button>
                        </div>
                      )}
                      <div className="resource-box">
                        <div className="panel-label">
                          本地执行资源 <span>{session.resources.length}</span>
                        </div>
                        {session.resources.length ? (
                          session.resources.map((r) => (
                            <div className="resource" key={r.id}>
                              <Terminal size={14} />
                              <code>PID {r.pid}</code>
                              <Status status={r.status} />
                            </div>
                          ))
                        ) : (
                          <p className="quiet">
                            <Check size={14} />
                            当前没有存活的工具进程
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </TabsContent>
                <TabsContent value="tools">
                  <div className="panel-label">
                    按需加载{' '}
                    <button
                      className="text-link"
                      onClick={() => setCatalogOpen(true)}
                    >
                      搜索目录
                      <ArrowRight size={13} />
                    </button>
                  </div>
                  <div className="loaded-section">
                    <p className="quiet">
                      工具定义 <span>{main?.loadedTools.length ?? 0}</span>
                    </p>
                    <div className="tag-list">
                      {main?.loadedTools.map((t) => (
                        <span key={t}>
                          <Box size={12} />
                          {t}
                          <button
                            aria-label={`卸载工具 ${t}`}
                            onClick={() =>
                              command('unload', { kind: 'tool', name: t })
                            }
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                    <p className="quiet">
                      Skill <span>{main?.loadedSkills.length ?? 0}</span>
                    </p>
                    <div className="tag-list skill-tags">
                      {main?.loadedSkills.map((t) => (
                        <span key={t}>
                          <button
                            className="skill-title"
                            onClick={() =>
                              api<CatalogItem>(`/catalog/skill/${t}`)
                                .then((s) =>
                                  setDetail({
                                    title: s.title,
                                    body: s.content ?? '',
                                  }),
                                )
                                .catch(fail)
                            }
                          >
                            <BookOpen size={12} />
                            {t}
                          </button>
                          <button
                            aria-label={`卸载 Skill ${t}`}
                            onClick={() =>
                              command('unload', { kind: 'skill', name: t })
                            }
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="panel-label">最近调用</div>
                  {session?.actions.length ? (
                    <div className="action-list">
                      {session.actions
                        .slice(-60)
                        .reverse()
                        .map((a) => (
                          <button
                            key={a.id}
                            className="action-row"
                            onClick={() =>
                              setDetail({ title: a.tool, body: pretty(a) })
                            }
                          >
                            <div>
                              <Terminal size={14} />
                              <code>{a.tool}</code>
                            </div>
                            <Status status={a.status} />
                          </button>
                        ))}
                    </div>
                  ) : (
                    <Empty
                      icon={<Box />}
                      title="尚无工具调用"
                      text="工具的参数、结果与授权状态可在这里查看。"
                    />
                  )}
                </TabsContent>
                <TabsContent value="context">
                  <div className="panel-label">
                    CONTEXT WINDOW <span>估算值</span>
                  </div>
                  <div className="budget-details">
                    <p>
                      可用输入 {context?.available?.toLocaleString() ?? '—'} ·
                      输出预留 {context?.reserve?.toLocaleString() ?? '—'}
                    </p>
                    <p>
                      估算余量 {context?.margin?.toLocaleString() ?? '—'}
                      ；不同模型的实际计数可能不同。
                    </p>
                    {Object.entries(context?.breakdown ?? {}).map(
                      ([key, value]) => (
                        <div key={key}>
                          <span>
                            {{
                              instructionsAndFacts: '说明与任务事实',
                              skills: '已加载 Skill',
                              tools: '工具定义',
                              summary: '历史摘要',
                              history: '近期对话',
                              rawResponse: '模型原始响应',
                            }[key] ?? key}
                          </span>
                          <span>{value.toLocaleString()}</span>
                        </div>
                      ),
                    )}
                  </div>
                  <div className="context-meter">
                    <div>
                      <strong>{(context?.tokens ?? 0).toLocaleString()}</strong>
                      <span>
                        /{' '}
                        {(
                          context?.budget ??
                          profile?.contextWindow ??
                          16000
                        ).toLocaleString()}{' '}
                        tokens
                      </span>
                    </div>
                    <div className="meter-track">
                      <div
                        style={{
                          width: `${Math.min(100, ((context?.tokens ?? 0) / (context?.budget ?? 16000)) * 100)}%`,
                        }}
                      />
                    </div>
                    <p>原始记录外部保存，工作上下文按需组装。</p>
                  </div>
                  <div className="context-facts">
                    <div>
                      <span>历史交互单元</span>
                      <strong>{context?.historyUnits ?? 0}</strong>
                    </div>
                    <div>
                      <span>已完成压缩</span>
                      <strong>{context?.compactions ?? 0} 次</strong>
                    </div>
                    <div>
                      <span>当前任务版本</span>
                      <strong>{session?.revision ?? 0}</strong>
                    </div>
                    <div>
                      <span>写入限制</span>
                      <strong>{session?.readOnly ? '只读' : '需要授权'}</strong>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className="full-width"
                    disabled={!session}
                    onClick={() => command('compact')}
                  >
                    <Layers size={15} />
                    手动压缩上下文
                  </Button>
                  <div className="panel-label spaced">历史摘要</div>
                  <pre className="summary-preview">
                    {context?.summary ||
                      '压缩发生后，这里显示保留的摘要。当前目标、授权和后台状态由运行时单独维护。'}
                  </pre>
                  {!!session?.handoffs.length && (
                    <>
                      <div className="panel-label spaced">模型交接记录</div>
                      {session.handoffs.map((h, i) => (
                        <button
                          key={i}
                          className="handoff-row"
                          onClick={() =>
                            setDetail({
                              title: '模型交接快照',
                              body: pretty(h),
                            })
                          }
                        >
                          {h.from}
                          <ArrowRight size={12} />
                          {h.to}
                        </button>
                      ))}
                    </>
                  )}
                </TabsContent>
                <TabsContent value="events">
                  <div className="panel-label">
                    事件时间线 <span>最新 {visibleEvents.length} 条</span>
                  </div>
                  {visibleEvents.length ? (
                    <div className="timeline">
                      {[...visibleEvents].reverse().map((e) => (
                        <button
                          key={e.id}
                          onClick={() =>
                            setDetail({
                              title: eventLabels[e.type] ?? e.type,
                              body: pretty(e),
                            })
                          }
                        >
                          <span
                            className={`event-dot ${e.type.includes('failed') ? 'bad' : e.type.includes('cancel') ? 'warn' : ''}`}
                          />
                          <div>
                            <strong>{eventLabels[e.type] ?? e.type}</strong>
                            <span>
                              {pretty(
                                e.data.tool ??
                                  e.data.name ??
                                  e.agentId ??
                                  '运行时',
                              )}
                            </span>
                          </div>
                          <time>{clock(e.time)}</time>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      icon={<Activity />}
                      title="等待第一个事件"
                      text="从模型请求到资源回收，每一步都有记录。"
                    />
                  )}
                </TabsContent>
                <TabsContent value="files">
                  <div className="panel-label">
                    原始产物 <span>{session?.artifacts.length ?? 0}</span>
                  </div>
                  {session?.artifacts.length ? (
                    <div className="artifact-list">
                      {session.artifacts.map((a) => (
                        <button
                          key={a.id}
                          onClick={() =>
                            api<Artifact>(
                              `/sessions/${selected}/artifacts/${a.id}`,
                            )
                              .then((d) =>
                                setDetail({
                                  title: d.name,
                                  body: d.content ?? '',
                                }),
                              )
                              .catch(fail)
                          }
                        >
                          <FileText size={19} />
                          <div>
                            <strong>{a.name}</strong>
                            <span>
                              {(a.bytes / 1024).toFixed(1)} KB · 本地保存
                            </span>
                          </div>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      icon={<FileText />}
                      title="尚未生成产物"
                      text="测试输出、诊断日志和交接记录会保存在任务中。"
                    />
                  )}
                  {session && (
                    <>
                      <div className="panel-label spaced">示例工作区</div>
                      <Button
                        variant="outline"
                        className="full-width"
                        onClick={() =>
                          api<{ files: { path: string; content: string }[] }>(
                            `/sessions/${selected}/files`,
                          )
                            .then((d) =>
                              setDetail({
                                title: '示例工作区',
                                body: d.files
                                  .map((f) => `── ${f.path} ──\n${f.content}`)
                                  .join('\n\n'),
                              }),
                            )
                            .catch(fail)
                        }
                      >
                        <Terminal size={15} />
                        查看工作文件
                      </Button>
                    </>
                  )}
                </TabsContent>
              </Tabs>
              <div className="inspector-footer">
                <ShieldCheck size={14} />
                <span>可追踪 · 可打断 · 有归属</span>
                <span
                  className={`activity-orb ${active ? 'orb-active' : ''}`}
                  title={active ? '任务运行中' : '任务就绪'}
                />
              </div>
            </aside>
          )}
        </div>
      </main>
      <Dialog open={catalogOpen} onOpenChange={setCatalogOpen}>
        <DialogContent className="catalog-dialog">
          <DialogHeader>
            <DialogTitle>能力目录</DialogTitle>
            <DialogDescription>
              {config?.counts.tools.toLocaleString()} 个工具 ·{' '}
              {config?.counts.skills.toLocaleString()} 个
              Skill。生成条目与真实本地能力分别标注。
            </DialogDescription>
          </DialogHeader>
          <div className="catalog-controls">
            <Tabs
              value={kind}
              onValueChange={(v) => {
                setKind(v);
                setCatalogPage(0);
                setCatalogDetail(null);
              }}
            >
              <TabsList>
                <TabsTrigger value="tool">工具</TabsTrigger>
                <TabsTrigger value="skill">Skill</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="search-field">
              <Search size={16} />
              <Input
                aria-label="搜索能力"
                placeholder="搜索名称、用途或分类…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCatalogPage(0);
                }}
              />
            </div>
          </div>
          <div className="catalog-layout">
            <div className="catalog-results">
              {catalog.items.map((item) => (
                <button
                  key={item.name}
                  className={
                    catalogDetail?.name === item.name ? 'selected' : ''
                  }
                  onClick={() =>
                    api<CatalogItem>(
                      `/catalog/${item.kind}/${encodeURIComponent(item.name)}`,
                    )
                      .then(setCatalogDetail)
                      .catch(fail)
                  }
                >
                  <div>
                    <strong>{item.title}</strong>
                    <span
                      className={`source-badge ${item.simulated ? '' : 'real'}`}
                    >
                      {item.simulated ? '生成演示' : '真实本地'}
                    </span>
                  </div>
                  <code>{item.name}</code>
                  <p>{item.description}</p>
                </button>
              ))}
              {!catalog.items.length && (
                <p className="quiet">没有匹配项，请换一个关键词。</p>
              )}
              <div className="pagination">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!catalogPage}
                  onClick={() => setCatalogPage((p) => p - 1)}
                >
                  上一页
                </Button>
                <span>
                  {catalogPage + 1} /{' '}
                  {Math.max(1, Math.ceil(catalog.total / 20))}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={(catalogPage + 1) * 20 >= catalog.total}
                  onClick={() => setCatalogPage((p) => p + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
            <div className="catalog-detail">
              {catalogDetail ? (
                <>
                  <h3>{catalogDetail.title}</h3>
                  <p className="quiet">来源：{catalogDetail.source}</p>
                  <pre>
                    {catalogDetail.content ?? pretty(catalogDetail.parameters)}
                  </pre>
                  {session && (
                    <Button
                      onClick={() =>
                        command('load', {
                          kind: catalogDetail.kind,
                          name: catalogDetail.name,
                        })
                      }
                    >
                      <Plus size={14} />
                      加载到主助手
                    </Button>
                  )}
                </>
              ) : (
                <Empty
                  icon={<BookOpen />}
                  title="选择一项能力"
                  text="查看完整定义，理解发现、加载与调用的区别。"
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="detail-dialog">
          <DialogHeader>
            <DialogTitle>{detail?.title}</DialogTitle>
            <DialogDescription>当前任务的真实记录与原始内容</DialogDescription>
          </DialogHeader>
          <pre>{detail?.body}</pre>
        </DialogContent>
      </Dialog>
      <Dialog open={fullPermissionOpen} onOpenChange={setFullPermissionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>允许当前对话完全访问？</DialogTitle>
            <DialogDescription>
              终端命令可以访问本机文件和网络，操作不再逐次审批。工作区外修改无法通过本应用回滚。只对当前对话或下一次新建任务生效。
            </DialogDescription>
          </DialogHeader>
          <Button
            onClick={() => {
              if (selected) void command('permissions', { mode: 'full' });
              else setPermissionMode('full');
              setFullPermissionOpen(false);
            }}
          >
            允许当前对话完全访问
          </Button>
          <Button
            variant="outline"
            onClick={() => setFullPermissionOpen(false)}
          >
            取消
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={changesOpen} onOpenChange={setChangesOpen}>
        <DialogContent className="settings-dialog">
          <DialogHeader>
            <DialogTitle>本次对话的修改记录</DialogTitle>
            <DialogDescription>
              独立 Git 检查点，不改变项目的分支或暂存区
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <WorkspaceChanges
              sessionId={selected}
              active={!!session && activeStates.includes(session.status)}
              onChanged={() => {
                void refreshList();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="settings-dialog">
          <DialogHeader>
            <DialogTitle>模型与运行设置</DialogTitle>
            <DialogDescription>配置 API、模型能力与连接测试</DialogDescription>
          </DialogHeader>
          <RuntimeSettings onChanged={refreshConfig} />
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
