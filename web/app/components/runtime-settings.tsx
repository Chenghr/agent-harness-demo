'use client';
import { useEffect, useState } from 'react';
import './runtime-settings.css';
export async function runtimeApi<T>(route: string, body?: unknown): Promise<T> {
  const r = await fetch(
    '/api' + route,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data: unknown = await r.json();
  if (!r.ok) {
    const error = data as { error?: { message?: string } };
    throw new Error(error.error?.message ?? '请求失败');
  }
  return data as T;
}
type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  protocol: string;
  hasKey: boolean;
};
type Model = {
  id: string;
  providerId: string;
  label: string;
  modelName: string;
  contextWindow: number;
  maxOutput: number;
  tools: boolean;
  reasoningEfforts: string[];
  effort: string;
  maxTokensField: string;
};
const blankProvider = {
  id: '',
  name: '',
  baseUrl: 'https://api.deepseek.com',
  protocol: 'chat-completions',
  apiKey: '',
};
const blankModel = {
  id: '',
  providerId: '',
  label: '',
  modelName: '',
  contextWindow: 32768,
  maxOutput: 4096,
  tools: true,
  reasoningEfforts: [] as string[],
  effort: '',
  maxTokensField: 'max_tokens',
};
export function RuntimeSettings({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<{ providers: Provider[]; models: Model[] }>({
      providers: [],
      models: [],
    }),
    [provider, setProvider] = useState(blankProvider),
    [model, setModel] = useState(blankModel),
    [discovered, setDiscovered] = useState<{ id: string }[]>([]),
    [note, setNote] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = () =>
    runtimeApi<typeof data>('/settings/models').then(setData);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await fn();
      await refresh();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="runtime-settings">
      <p className="runtime-hint">
        在本机保存，下一次请求生效。密钥保存后不回传；当前使用仅支持文本和工具调用。
      </p>
      <div className="runtime-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setProvider({ ...blankProvider, name: 'DeepSeek 官方' });
            setModel({
              ...blankModel,
              modelName: 'deepseek-flash',
              label: 'DeepSeek · Flash',
              contextWindow: 1000000,
              maxOutput: 8192,
              reasoningEfforts: ['none', 'low', 'high', 'max'],
              effort: 'none',
            });
            setDiscovered([]);
            setError('');
            setNote(
              '已填入 DeepSeek 配置。先填写密钥并保存服务，再保存模型、测试调用。默认关闭思考，便于先验证简单任务；可改为 low / high / max。',
            );
          }}
        >
          DeepSeek 官方预设
        </button>
      </div>
      {error && (
        <p role="alert" className="runtime-error">
          {error}
        </p>
      )}
      {note && <output>{note}</output>}
      <div className="runtime-provider-list">
        {data.providers.map((p) => (
          <button key={p.id} onClick={() => setProvider({ ...p, apiKey: '' })}>
            <strong>{p.name}</strong>
            <span>
              {p.hasKey ? '密钥已保存' : '无密钥'} · {p.protocol}
            </span>
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const saved = await runtimeApi<Provider>('/settings/providers', {
              ...provider,
              id: provider.id || undefined,
              apiKey: provider.apiKey || undefined,
            });
            setProvider({ ...saved, apiKey: '' });
            setModel((m) => ({ ...m, providerId: saved.id }));
            setNote('服务已保存。继续添加模型信息。');
          });
        }}
      >
        <div className="runtime-section-title">
          <strong>{provider.id ? '编辑服务' : '添加模型服务'}</strong>
          <button type="button" onClick={() => setProvider(blankProvider)}>
            添加另一个
          </button>
        </div>
        <div className="runtime-fields">
          <label>
            服务名称
            <input
              required
              value={provider.name}
              onChange={(e) =>
                setProvider({ ...provider, name: e.target.value })
              }
              placeholder="DeepSeek / 内部网关"
            />
          </label>
          <label>
            协议
            <select
              value={provider.protocol}
              onChange={(e) =>
                setProvider({ ...provider, protocol: e.target.value })
              }
            >
              <option value="chat-completions">Chat Completions</option>
              <option value="responses">Responses</option>
            </select>
          </label>
          <label className="wide">
            API 地址
            <input
              required
              type="url"
              value={provider.baseUrl}
              onChange={(e) =>
                setProvider({ ...provider, baseUrl: e.target.value })
              }
            />
          </label>
          <label className="wide">
            API 密钥
            <input
              type="password"
              autoComplete="new-password"
              value={provider.apiKey}
              onChange={(e) =>
                setProvider({ ...provider, apiKey: e.target.value })
              }
              placeholder={
                provider.id ? '留空保留原密钥' : '本地免密服务可留空'
              }
            />
          </label>
        </div>
        <button disabled={busy}>保存服务</button>
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const saved = await runtimeApi<Model>('/settings/models', {
              ...model,
              reasoningEfforts: model.reasoningEfforts.filter(Boolean),
              id: model.id || undefined,
            });
            setModel(saved);
            setNote('模型已保存，可在对话底部选择。');
          });
        }}
      >
        <div className="runtime-section-title">
          <strong>{model.id ? '编辑模型' : '添加模型'}</strong>
          <button
            type="button"
            onClick={() => setModel({ ...blankModel, providerId: provider.id })}
          >
            添加另一个
          </button>
        </div>
        <div className="runtime-fields">
          <label>
            所属服务
            <select
              required
              value={model.providerId}
              onChange={(e) => {
                setModel({ ...model, providerId: e.target.value });
                setDiscovered([]);
              }}
            >
              <option value="">选择服务</option>
              {data.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            模型 ID
            <input
              required
              list="available-models"
              value={model.modelName}
              onChange={(e) =>
                setModel({ ...model, modelName: e.target.value })
              }
              placeholder="服务实际接受的模型 ID"
            />
            <datalist id="available-models">
              {discovered.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </datalist>
          </label>
          <label>
            显示名称
            <input
              value={model.label}
              onChange={(e) => setModel({ ...model, label: e.target.value })}
              placeholder="可选"
            />
          </label>
          <label>
            输出参数
            <select
              value={model.maxTokensField}
              onChange={(e) =>
                setModel({ ...model, maxTokensField: e.target.value })
              }
            >
              <option value="max_tokens">max_tokens（常见兼容服务）</option>
              <option value="max_completion_tokens">
                max_completion_tokens
              </option>
            </select>
          </label>
          <label>
            上下文上限（tokens）
            <input
              required
              type="number"
              min="2000"
              value={model.contextWindow}
              onChange={(e) =>
                setModel({ ...model, contextWindow: Number(e.target.value) })
              }
            />
          </label>
          <label>
            输出上限（tokens）
            <input
              required
              type="number"
              min="1"
              value={model.maxOutput}
              onChange={(e) =>
                setModel({ ...model, maxOutput: Number(e.target.value) })
              }
            />
          </label>
          <label>
            支持的思考等级
            <input
              value={model.reasoningEfforts.join(',')}
              onChange={(e) =>
                setModel({
                  ...model,
                  reasoningEfforts: e.target.value
                    .split(',')
                    .map((x) => x.trim()),
                  effort: '',
                })
              }
              placeholder="按服务文档填写，如 low,high；可留空"
            />
          </label>
          <label>
            默认思考等级
            <select
              value={model.effort}
              onChange={(e) => setModel({ ...model, effort: e.target.value })}
            >
              <option value="">使用服务默认</option>
              {model.reasoningEfforts.filter(Boolean).map((v) => (
                <option key={v} value={v}>
                  {v === 'none' ? '关闭思考（none）' : v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="runtime-hint">
          以上能力来自你的配置，获取模型列表不会验证上下文上限。请按服务文档填写；本应用要求模型支持工具调用。
          DeepSeek 预设按官方 1M 上下文填写输入预算，单次输出先限制为
          8192。测试调用会完成一次工具往返，最多等待两分钟。
        </p>
        <div className="runtime-actions">
          <button disabled={busy || !model.providerId}>保存模型</button>
          <button
            type="button"
            disabled={busy || !model.providerId}
            onClick={() =>
              void run(async () => {
                const r = await runtimeApi<{ models: { id: string }[] }>(
                  '/settings/discover',
                  { providerId: model.providerId },
                );
                setDiscovered(r.models);
                setNote(
                  `发现 ${r.models.length} 个模型，在模型 ID 输入框选择；也可直接手动填写。`,
                );
              })
            }
          >
            获取模型列表
          </button>
        </div>
      </form>
      {data.models.map((m) => (
        <div className="runtime-model-row" key={m.id}>
          <div>
            <strong>{m.label}</strong>
            <small>
              {m.modelName} · {m.contextWindow.toLocaleString()} / 输出{' '}
              {m.maxOutput.toLocaleString()} · 用户配置
            </small>
          </div>
          <button onClick={() => setModel(m)}>编辑</button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await runtimeApi<{ durationMs: number }>(
                  '/settings/test',
                  { modelId: m.id },
                );
                setNote(
                  `${m.label}：连接及工具往返测试通过，用时 ${(r.durationMs / 1000).toFixed(1)} 秒。此测试不验证最大上下文。`,
                );
              })
            }
          >
            测试调用
          </button>
        </div>
      ))}
      <p className="runtime-hint">
        凭据存放在应用数据目录的独立文件，权限为仅当前系统用户可读写（0600），不加密；不进入工作区
        Git。已有 .env 配置仍可使用。
      </p>
    </div>
  );
}
export type Workspace = {
  id: string;
  name: string;
  path: string;
  activeSession?: string;
};
export function WorkspaceChooser({
  items,
  value,
  onSelect,
  onAdded,
}: {
  items: Workspace[];
  value: string;
  onSelect: (id: string) => void;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false),
    [directory, setDirectory] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function add(pick: boolean) {
    setBusy(true);
    setError('');
    try {
      const p = await runtimeApi<Workspace>(
        pick ? '/workspaces/pick' : '/workspaces',
        pick ? {} : { path: directory },
      );
      onAdded();
      onSelect(p.id);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace-control">
      <select
        aria-label="选择工作区"
        value={value}
        onChange={(e) => onSelect(e.target.value)}
      >
        <option value="">示例工作区</option>
        {items.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <button onClick={() => setOpen((v) => !v)}>添加目录</button>
      <span title={items.find((w) => w.id === value)?.path}>
        {items.find((w) => w.id === value)?.path ?? '独立教学示例'}
      </span>
      {open && (
        <div className="workspace-add">
          <strong>添加本地工作区</strong>
          <input
            aria-label="工作区绝对路径"
            placeholder="/Users/你的用户名/Documents/项目"
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
          />
          <div className="runtime-actions">
            <button disabled={busy} onClick={() => void add(true)}>
              选择文件夹（macOS）
            </button>
            <button
              disabled={busy || !directory}
              onClick={() => void add(false)}
            >
              添加此路径
            </button>
          </div>
          <small>修改记录保存在本机，支持普通文件夹和已有 Git 仓库。</small>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
