'use client';
import { useEffect, useState } from 'react';
import Image from 'next/image';
import { runtimeApi } from './runtime-settings';
import './delivery.css';

export type DeliveryState = {
  requirements?: {
    members: string[];
    limits: Record<string, number>;
    version: number;
  };
  assets: {
    id: string;
    key: string;
    slot: string;
    version: number;
    status: string;
    model: string;
    url?: string;
    error?: string;
    retryCount?: number;
  }[];
  selections: Record<string, string>;
  media: {
    id: string;
    kind: 'music' | 'video';
    key: string;
    slot: string;
    version: number;
    status: string;
    model: string;
    url?: string;
    error?: string;
    duration?: number;
    resolution?: string;
    externalTaskId?: string;
  }[];
  mediaSelections: Record<string, string>;
  previews: {
    id: string;
    title: string;
    url: string;
    digest: string;
    files: { name: string; bytes: number }[];
    createdAt: string;
    theme?: string;
    layout?: string;
    checks?: {
      id: string;
      label: string;
      status: string;
      detail: string;
    }[];
  }[];
  publications: {
    id: string;
    previewId: string;
    status: string;
    target: string;
    digest: string;
    url?: string;
    error?: string;
  }[];
};
type ImageModel = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: string;
  hasKey?: boolean;
  maxConcurrency?: number;
};
type MediaModel = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: string;
  hasKey?: boolean;
};
const blankImage = {
  id: '',
  name: '',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  protocol: 'gpt-image',
  maxConcurrency: 2,
  apiKey: '',
};
const blankPublish = {
  name: 'Netlify',
  baseUrl: 'https://api.netlify.com/api/v1',
  siteId: '',
  apiKey: '',
};
const blankMusic = {
  id: '',
  name: '腾讯 TokenHub MiniMax Music 3.0',
  baseUrl: 'https://tokenhub.tencentmaas.com/v1/wand/minimax-music/generation',
  model: 'minimax-music-v3.0',
  protocol: 'tokenhub-minimax-music',
  apiKey: '',
};
const blankVideo = {
  id: '',
  name: '百炼 Wan 3.0 Video',
  baseUrl:
    'https://ws-f1727rbl0fr6i3pn.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',
  model: 'wan3.0-video-prime',
  protocol: 'dashscope-video-async',
  apiKey: '',
};

export function DeliverySettings({ onChanged }: { onChanged: () => void }) {
  const [models, setModels] = useState<ImageModel[]>([]);
  const [image, setImage] = useState(blankImage),
    [music, setMusic] = useState(blankMusic),
    [video, setVideo] = useState(blankVideo),
    [publisher, setPublisher] = useState(blankPublish);
  const [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    runtimeApi<{
      images: ImageModel[];
      music: MediaModel | null;
      video: MediaModel | null;
      publisher: typeof blankPublish | null;
    }>(
      '/settings/delivery',
    )
      .then((d) => {
        setModels(d.images);
        if (d.music) setMusic({ ...d.music, apiKey: '' });
        if (d.video) setVideo({ ...d.video, apiKey: '' });
        if (d.publisher) setPublisher({ ...d.publisher, apiKey: '' });
      })
      .catch((e) => setError(e.message));
  }, []);
  async function save(kind: string, value: object & { apiKey: string }) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const d = await runtimeApi<{
        images: ImageModel[];
        music: MediaModel | null;
        video: MediaModel | null;
      }>(
        `/settings/delivery/${kind}`,
        { ...value, apiKey: value.apiKey || undefined },
      );
      setModels(d.images);
      if (kind === 'image' && d.images.at(-1))
        setImage({ ...d.images.at(-1)!, maxConcurrency: d.images.at(-1)!.maxConcurrency ?? 2, apiKey: '' });
      setPublisher((v) => ({ ...v, apiKey: '' }));
      if (d.music) setMusic({ ...d.music, apiKey: '' });
      if (d.video) setVideo({ ...d.video, apiKey: '' });
      setNotice('已保存，下次请求生效。');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="delivery-settings">
      <details>
        <summary>图片、音视频与网站发布服务</summary>
        <p>
          图片、音乐、视频模型与对话模型分别配置。密钥只保存在本机；留空保留已保存的密钥。
        </p>
        {error && <p role="alert">{error}</p>}
        {notice && <output>{notice}</output>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save('image', image);
          }}
        >
          <strong>出图服务</strong>
          <select
            aria-label="编辑出图服务"
            value={image.id}
            onChange={(e) =>
              setImage(
                e.target.value
                  ? {
                      ...models.find((m) => m.id === e.target.value)!,
                      maxConcurrency:
                        models.find((m) => m.id === e.target.value)!.maxConcurrency ?? 2,
                      apiKey: '',
                    }
                  : blankImage,
              )
            }
          >
            <option value="">添加新的出图服务</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.model}
              </option>
            ))}
          </select>
          <label>
            服务名称
            <input
              required
              value={image.name}
              onChange={(e) => setImage({ ...image, name: e.target.value })}
            />
          </label>
          <label>
            图片 API 地址
            <input
              required
              value={image.baseUrl}
              onChange={(e) => setImage({ ...image, baseUrl: e.target.value })}
            />
          </label>
          <label>
            图片模型 ID
            <input
              required
              placeholder="填写服务提供的模型 ID"
              value={image.model}
              onChange={(e) => setImage({ ...image, model: e.target.value })}
            />
          </label>
          <label>
            图片协议
            <select
              value={image.protocol}
              onChange={(e) => setImage({ ...image, protocol: e.target.value })}
            >
              <option value="gpt-image">GPT Image（默认返回 Base64）</option>
              <option value="b64-compatible">
                兼容 Images API（指定 b64_json）
              </option>
              <option value="dashscope-multimodal">
                阿里云百炼（多模态生成）
              </option>
            </select>
          </label>
          <label>
            图片 API Key
            <input
              type="password"
              autoComplete="off"
              value={image.apiKey}
              onChange={(e) => setImage({ ...image, apiKey: e.target.value })}
            />
          </label>
          <label>
            单服务最大并发（建议百炼设为 2）
            <input
              type="number"
              min={1}
              max={4}
              value={image.maxConcurrency ?? 2}
              onChange={(e) =>
                setImage({ ...image, maxConcurrency: Number(e.target.value) })
              }
            />
          </label>
          <button disabled={busy}>保存出图服务</button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save('music', music);
          }}
        >
          <strong>背景音乐生成服务</strong>
          <label>
            服务名称
            <input required value={music.name} onChange={(e) => setMusic({ ...music, name: e.target.value })} />
          </label>
          <label>
            音乐 API 地址
            <input required value={music.baseUrl} onChange={(e) => setMusic({ ...music, baseUrl: e.target.value })} />
          </label>
          <label>
            音乐模型 ID
            <input required value={music.model} onChange={(e) => setMusic({ ...music, model: e.target.value })} />
          </label>
          <label>
            音乐协议
            <select value={music.protocol} onChange={(e) => setMusic({ ...music, protocol: e.target.value })}>
              <option value="tokenhub-minimax-music">腾讯 TokenHub（MiniMax Music）</option>
              <option value="dashscope-music">阿里云百炼（Fun Music）</option>
            </select>
          </label>
          <label>
            音乐 API Key
            <input type="password" autoComplete="off" value={music.apiKey} onChange={(e) => setMusic({ ...music, apiKey: e.target.value })} />
          </label>
          <p>生成纯器乐背景音乐；远程临时结果会立即下载为本地版本。</p>
          <button disabled={busy}>保存音乐服务</button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save('video', video);
          }}
        >
          <strong>感谢视频生成服务</strong>
          <label>
            服务名称
            <input required value={video.name} onChange={(e) => setVideo({ ...video, name: e.target.value })} />
          </label>
          <label>
            视频 API 地址
            <input required value={video.baseUrl} onChange={(e) => setVideo({ ...video, baseUrl: e.target.value })} />
          </label>
          <label>
            视频模型 ID
            <input required value={video.model} onChange={(e) => setVideo({ ...video, model: e.target.value })} />
          </label>
          <label>
            视频 API Key
            <input type="password" autoComplete="off" value={video.apiKey} onChange={(e) => setVideo({ ...video, apiKey: e.target.value })} />
          </label>
          <p>演示规格固定为约 10 秒、720P、16:9；异步任务不会盲目重复提交。</p>
          <button disabled={busy}>保存视频服务</button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save('publisher', publisher);
          }}
        >
          <strong>发布服务</strong>
          <label>
            发布服务名称
            <input
              required
              value={publisher.name}
              onChange={(e) =>
                setPublisher({ ...publisher, name: e.target.value })
              }
            />
          </label>
          <label>
            发布 API 地址
            <input
              required
              value={publisher.baseUrl}
              onChange={(e) =>
                setPublisher({ ...publisher, baseUrl: e.target.value })
              }
            />
          </label>
          <label>
            Netlify Site ID
            <input
              required
              value={publisher.siteId}
              onChange={(e) =>
                setPublisher({ ...publisher, siteId: e.target.value })
              }
            />
          </label>
          <label>
            Netlify Token
            <input
              type="password"
              autoComplete="off"
              value={publisher.apiKey}
              onChange={(e) =>
                setPublisher({ ...publisher, apiKey: e.target.value })
              }
            />
          </label>
          <p>发布会更新这个站点。每个预览版本都需要在任务中单独批准。</p>
          <button disabled={busy}>保存发布服务</button>
        </form>
      </details>
    </section>
  );
}

const statuses: Record<string, string> = {
  generating: '生成中',
  ready: '可用',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已中断',
  awaiting_approval: '等待批准',
  publishing: '发布中',
  published: '已发布',
  stale: '内容已变更，请重新申请',
  denied: '已拒绝',
  unknown: '远程结果待核对',
};
export function DeliveryPanel({
  sessionId,
  state,
}: {
  sessionId: string;
  state: DeliveryState;
}) {
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [selectedPreview, setSelectedPreview] = useState<string | null>(null);
  const [names, setNames] = useState(
    state.requirements?.members.join('\n') ?? '',
  );
  const [limits, setLimits] = useState(
    Object.entries(state.requirements?.limits ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  const preview =
    state.previews.find((p) => p.id === selectedPreview) ??
    state.previews.at(-1);
  async function action(route: string, body: unknown) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await runtimeApi(`/sessions/${sessionId}/delivery/${route}`, body);
      setNotice('已处理');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="delivery-panel">
      <p>
        出图、预览与发布分别记录。只使用虚构形象；不会读取相册或上传人脸照片。
      </p>
      {error && (
        <p role="alert" className="runtime-error">
          {error}
        </p>
      )}
      {notice && <output>{notice}</output>}
      <details>
        <summary>祝福网站的成员与字数要求</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const rows = limits.split('\n').filter((x) => x.trim());
            if (rows.some((row) => !/^.+=\d+$/.test(row))) {
              setError('字数限制格式：王磊=50，每行一位');
              return;
            }
            void action('requirements', {
              members: names
                .split('\n')
                .map((x) => x.trim())
                .filter(Boolean),
              limits: Object.fromEntries(
                rows.map((row) => {
                  const at = row.lastIndexOf('=');
                  return [row.slice(0, at).trim(), Number(row.slice(at + 1))];
                }),
              ),
            });
          }}
        >
          <label>
            参与成员，每行一位
            <textarea
              required
              value={names}
              onChange={(e) => setNames(e.target.value)}
            />
          </label>
          <label>
            字数上限，可选（例如：王磊=50）
            <textarea
              value={limits}
              onChange={(e) => setLimits(e.target.value)}
            />
          </label>
          <button disabled={busy}>保存网站要求</button>
        </form>
      </details>
      <strong>图片版本</strong>
      {!state.assets.length && (
        <p>还没有图片。配置出图服务后，可以让助手生成虚拟形象。</p>
      )}
      <div className="delivery-images">
        {state.assets.map((asset) => (
          <article key={asset.id}>
            {asset.url && (
              <Image
                unoptimized
                width={512}
                height={512}
                src={asset.url}
                alt={`${asset.key}版本${asset.version}`}
              />
            )}
            <strong>
              {asset.key} · 第 {asset.version} 版
            </strong>
            <small>
              {asset.model} · {statuses[asset.status] ?? asset.status}
            </small>
            {!!asset.retryCount && (
              <small className="delivery-retry">自动退避重试 {asset.retryCount} 次</small>
            )}
            {asset.error && <p>{asset.error}</p>}
            {asset.status === 'ready' && (
              <button
                disabled={busy || state.selections[asset.slot] === asset.id}
                onClick={() => void action('select', { assetId: asset.id })}
              >
                {state.selections[asset.slot] === asset.id
                  ? '当前版本'
                  : '使用此版本'}
              </button>
            )}
          </article>
        ))}
      </div>
      <strong>音乐与视频版本</strong>
      {!state.media?.length && (
        <p>还没有媒体。教师节一键任务会生成一段背景音乐和一段感谢短片。</p>
      )}
      <div className="delivery-media">
        {(state.media ?? []).map((item) => (
          <article key={item.id}>
            <div>
              <strong>
                {item.kind === 'music' ? '背景音乐' : '感谢视频'} · 第 {item.version} 版
              </strong>
              <small>
                {item.model} · {statuses[item.status] ?? item.status}
              </small>
              {item.kind === 'video' && (
                <small>{item.resolution ?? '720P'} · 约 {item.duration ?? 10} 秒</small>
              )}
              {item.externalTaskId && <small>远程任务：{item.externalTaskId}</small>}
              {item.error && <p>{item.error}</p>}
            </div>
            {item.status === 'ready' && item.url && item.kind === 'music' && (
              // oxlint-disable-next-line jsx-a11y/media-has-caption -- generated music is instrumental
              <audio controls preload="metadata" src={item.url} />
            )}
            {item.status === 'ready' && item.url && item.kind === 'video' && (
              // oxlint-disable-next-line jsx-a11y/media-has-caption -- generated video is intentionally silent
              <video controls preload="metadata" src={item.url} />
            )}
            {item.status === 'ready' && (
              <button
                disabled={busy || state.mediaSelections?.[item.slot] === item.id}
                onClick={() => void action('select-media', { mediaId: item.id })}
              >
                {state.mediaSelections?.[item.slot] === item.id ? '当前版本' : '使用此版本'}
              </button>
            )}
          </article>
        ))}
      </div>
      <strong>网站预览</strong>
      {!preview && <p>让助手生成网站预览后，会在这里显示。</p>}
      {preview && (
        <>
          <select
            aria-label="选择网站预览"
            value={preview.id}
            onChange={(e) => setSelectedPreview(e.target.value)}
          >
            {state.previews.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} · {new Date(p.createdAt).toLocaleTimeString()}
              </option>
            ))}
          </select>
          <iframe
            key={preview.id}
            title="网站预览"
            sandbox="allow-scripts"
            src={preview.url}
          />
          <a href={preview.url} target="_blank" rel="noreferrer">
            在新页面查看预览
          </a>
          <section className="delivery-checks" aria-label="预览确定性检查">
            <header>
              <div>
                <strong>固定预览检查</strong>
                <small>
                  {preview.theme ?? '基础主题'} · {preview.layout ?? 'gallery'}
                </small>
              </div>
              <span>
                {preview.checks?.every((check) => check.status === 'pass')
                  ? '硬性检查通过'
                  : '等待检查'}
              </span>
            </header>
            {preview.checks?.map((check) => (
              <p key={check.id}>
                <i className={check.status === 'pass' ? 'pass' : ''} />
                <strong>{check.label}</strong>
                <small>{check.detail}</small>
              </p>
            ))}
            <footer>头像视觉一致性仍需用户查看实际画面确认。</footer>
          </section>
          <details>
            <summary>将发布的 {preview.files.length} 个文件</summary>
            {preview.files.map((f) => (
              <p key={f.name}>
                {f.name} · {f.bytes} 字节
              </p>
            ))}
          </details>
          <button
            disabled={busy}
            onClick={() =>
              void action('request-publish', { previewId: preview.id })
            }
          >
            申请发布这个预览
          </button>
        </>
      )}
      {state.publications.map((p) => (
        <section key={p.id} className="publication-card">
          <strong>{statuses[p.status] ?? p.status}</strong>
          <p>目标站点：{p.target}</p>
          <small>预览版本：{p.previewId}</small>
          {p.status === 'awaiting_approval' && (
            <>
              <p>将把这个预览公开发布到上述站点，并更新该站点内容。</p>
              <button
                disabled={busy}
                onClick={() => {
                  setSelectedPreview(p.previewId);
                }}
              >
                查看待发布版本
              </button>
              <button
                disabled={busy || preview?.id !== p.previewId}
                onClick={() =>
                  void action('publish', {
                    requestId: p.id,
                    decision: 'approve',
                  })
                }
              >
                确认公开发布此版本
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void action('publish', { requestId: p.id, decision: 'deny' })
                }
              >
                拒绝发布
              </button>
            </>
          )}
          {p.url && (
            <a href={p.url} target="_blank" rel="noreferrer">
              打开已发布的网站
            </a>
          )}
          {p.error && <p>{p.error}</p>}
        </section>
      ))}
    </div>
  );
}
