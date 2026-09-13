'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  Search,
  Upload,
  ShieldCheck,
  FileCheck,
  X,
  RefreshCw,
} from 'lucide-react';
import type {
  Directory,
  Pending,
} from '../../../server/runtime/capabilities/types';
import './capability-manager.css';

import { request, statusText } from './capability-api';
import type { Detail, View, Job, Model } from './capability-api';
import {
  ImportForm,
  ImportDecision,
  BatchImportDecision,
} from './capability-import';
import { DetailPanel } from './capability-detail';

export function CapabilityManager() {
  const [nodes, setNodes] = useState<Directory[]>([]);
  const [directory, setDirectory] = useState('root');
  const [view, setView] = useState<View | null>(null);
  const [section, setSection] = useState('directory');
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [selectedImports, setSelectedImports] = useState<string[]>([]);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editingOverview, setEditingOverview] = useState(false);
  const [overview, setOverview] = useState('');
  const [abstract, setAbstract] = useState('');
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision((v) => v + 1);
  const refresh = useCallback(async () => {
    const [tree, imports, evaluations] = await Promise.all([
      request<{ nodes: Directory[] }>('/management/tree'),
      request<{ items: Pending[]; total: number }>('/management/imports'),
      request<{ jobs: Job[] }>('/management/jobs'),
    ]);
    setNodes(tree.nodes);
    setPending(imports.items);
    setPendingTotal(imports.total);
    setJobs(evaluations.jobs);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh().catch((e) => setError(e.message));
    }, 0);
    return () => clearTimeout(timer);
  }, [refresh, revision]);
  useEffect(() => {
    request<{ models: Model[] }>('/config')
      .then((data) =>
        setModels(data.models.filter((m) => !m.simulated && m.configured)),
      )
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    let cancelled = false;
    const route = search
      ? `/management/search?q=${encodeURIComponent(search)}&directory=${directory}`
      : `/management/directory?id=${directory}`;
    request<View>(`${route}&kind=${kind}&offset=${offset}`)
      .then((data) => {
        if (!cancelled) setView(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [directory, offset, kind, search, revision]);
  useEffect(() => {
    if (!jobs.some((j) => j.status === 'queued' || j.status === 'running'))
      return;
    const timer = setInterval(
      () => refresh().catch((e) => setError(e.message)),
      1200,
    );
    return () => clearInterval(timer);
  }, [jobs, refresh]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const openDirectory = (id: string) => {
    setDirectory(id);
    setSection('directory');
    setOffset(0);
    setSelected([]);
    setSearch('');
    setQuery('');
    setEditingOverview(false);
  };
  const openItem = (id: string) =>
    run(async () => {
      setDetail(
        await request<Detail>(`/management/item/${encodeURIComponent(id)}`),
      );
    });
  const evaluate = (evaluationKind: 'quality' | 'safety', ids = selected) =>
    run(async () => {
      await request('/management/evaluate', {
        ids,
        kind: evaluationKind,
        model,
      });
      setNotice('已创建独立评估。可在“评估记录”查看进度和取消。');
    });
  function tree(parent: string, depth = 0): React.ReactNode {
    return nodes
      .filter((n) => n.parent === parent)
      .map((node) => (
        <details
          key={node.id}
          open={(view?.path ?? []).some((p) => p.id === node.id)}
        >
          <summary>
            <button
              style={{ paddingLeft: 10 + depth * 10 }}
              className={directory === node.id ? 'chosen' : ''}
              onClick={() => openDirectory(node.id)}
            >
              <Folder size={15} />
              {node.name}
            </button>
          </summary>
          {tree(node.id, depth + 1)}
        </details>
      ));
  }
  return (
    <div className="cap-app">
      <aside className="cap-sidebar">
        <Link className="cap-back" href="/">
          <ArrowLeft size={16} />
          返回工作台
        </Link>
        <h1>能力管理</h1>
        <p>按场景了解方法与工具</p>
        <nav aria-label="能力管理导航">
          <button
            className={section === 'directory' ? 'chosen' : ''}
            onClick={() => openDirectory('root')}
          >
            <Folder size={17} />
            分类目录
          </button>
          <button
            className={section === 'imports' ? 'chosen' : ''}
            onClick={() => setSection('imports')}
          >
            <Upload size={17} />
            待处理导入 <span>{pendingTotal}</span>
          </button>
          <button
            className={section === 'jobs' ? 'chosen' : ''}
            onClick={() => setSection('jobs')}
          >
            <FileCheck size={17} />
            评估记录
          </button>
        </nav>
        <div className="cap-tree" aria-label="场景分类树">
          {tree('root')}
        </div>
        <p className="cap-footnote">
          目录说明帮助选择。加载方法、允许执行和评价质量分别管理。
        </p>
      </aside>
      <main className="cap-main">
        <header className="cap-header">
          <div>
            <span className="cap-eyebrow">HARNESS LAB</span>
            <h2>
              {section === 'imports'
                ? '处理导入'
                : section === 'jobs'
                  ? '独立评估记录'
                  : '分类目录'}
            </h2>
          </div>
          <button className="cap-primary" onClick={() => setImportOpen(true)}>
            <Upload size={16} />
            导入能力
          </button>
        </header>
        {error && (
          <div role="alert" className="cap-alert">
            {error}
            <button aria-label="关闭错误" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {notice && <output className="cap-notice">{notice}</output>}
        <div className="cap-model">
          <label htmlFor="review-model">独立评估模型</label>
          <select
            id="review-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">仅规则检查 · 不生成完整质量分</option>
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.configured}>
                {m.label}
                {!m.configured ? '（未配置）' : ''}
              </option>
            ))}
          </select>
        </div>
        {section === 'directory' && (
          <>
            <div className="cap-breadcrumb">
              <button onClick={() => openDirectory('root')}>全部</button>
              {(view?.path ?? [])
                .filter((p) => p.id !== 'root')
                .map((p) => (
                  <span key={p.id}>
                    <ChevronRight size={14} />
                    <button onClick={() => openDirectory(p.id)}>
                      {p.name}
                    </button>
                  </span>
                ))}
            </div>
            {!search && view && (
              <section className="cap-overview">
                <div className="cap-row">
                  <h3>{view.name}</h3>
                  <button
                    onClick={() => {
                      setEditingOverview(!editingOverview);
                      setOverview(view.overview);
                      setAbstract(view.abstract);
                    }}
                  >
                    编辑目录说明
                  </button>
                </div>
                {editingOverview ? (
                  <div className="cap-form">
                    <label>
                      在上级显示的摘要
                      <input
                        value={abstract}
                        onChange={(e) => setAbstract(e.target.value)}
                      />
                    </label>
                    <label>
                      本层概述
                      <textarea
                        rows={6}
                        value={overview}
                        onChange={(e) => setOverview(e.target.value)}
                      />
                    </label>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await request('/management/directory', {
                            id: directory,
                            abstract,
                            overview,
                          });
                          setEditingOverview(false);
                        })
                      }
                    >
                      保存人工说明
                    </button>
                  </div>
                ) : (
                  <p>{view.overview || '打开下级目录，查看具体用途。'}</p>
                )}
                {view.stale && (
                  <details>
                    <summary className="cap-warning">
                      下级内容已变化，人工说明待更新
                    </summary>
                    <p>{view.suggestedOverview}</p>
                    <button
                      onClick={() =>
                        run(async () => {
                          await request('/management/directory', {
                            id: directory,
                            abstract: view.suggestedAbstract,
                            overview: view.suggestedOverview,
                          });
                        })
                      }
                    >
                      采用这份更新建议
                    </button>
                  </details>
                )}
                <small>
                  {view.origin === 'manual'
                    ? '人工修订'
                    : '根据真实下级简介整理'}{' '}
                  · 说明版本 {view.version}
                </small>
              </section>
            )}
            <form
              className="cap-search"
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(query);
                setOffset(0);
              }}
            >
              <Search size={18} />
              <input
                aria-label="搜索当前目录"
                placeholder="在当前目录的概述与能力简介中搜索"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button type="submit">搜索</button>
              {search && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    setQuery('');
                  }}
                >
                  清除
                </button>
              )}
              <select
                aria-label="能力类型"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="all">全部类型</option>
                <option value="skill">Skill</option>
                <option value="tool">工具</option>
              </select>
            </form>
            <div className="cap-row cap-toolbar">
              <span>
                {view?.total ?? 0} 个入口
                {selected.length > 0 && ` · 已选 ${selected.length} 项`}
              </span>
              <div>
                <button
                  disabled={!selected.length || busy}
                  onClick={() => evaluate('quality')}
                >
                  <FileCheck size={15} />
                  质量评估
                </button>
                <button
                  disabled={!selected.length || busy}
                  onClick={() => evaluate('safety')}
                >
                  <ShieldCheck size={15} />
                  安全评估
                </button>
                <button
                  disabled={!selected.length || busy}
                  onClick={() =>
                    run(async () => {
                      await request('/management/scan', { ids: selected });
                      setNotice('选中项已重新扫描。');
                    })
                  }
                >
                  <RefreshCw size={15} />
                  扫描
                </button>
              </div>
            </div>
            {selected.length > 0 && (
              <details className="cap-selection-actions">
                <summary>调整选中项分类与关系（{selected.length} 项）</summary>
                <form
                  className="cap-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    void run(async () => {
                      for (const id of selected)
                        await request(`/management/item/${id}`, {
                          directories: data.getAll('directories'),
                        });
                      setNotice('已调整选中项分类。');
                    });
                  }}
                >
                  <label>
                    移动到分类
                    <select multiple name="directories" required size={4}>
                      {nodes
                        .filter((n) => n.id !== 'root')
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {nodes.find((p) => p.id === n.parent)?.name} /{' '}
                            {n.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button disabled={busy}>
                    应用到选中的 {selected.length} 项
                  </button>
                </form>
                {selected.length === 2 && (
                  <form
                    className="cap-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      void run(async () => {
                        await request('/management/relation', {
                          ids: selected,
                          type: data.get('type'),
                          reason: data.get('reason'),
                        });
                        setNotice('已保存两项能力在当前版本的关系。');
                      });
                    }}
                  >
                    <label>
                      这两项的关系
                      <select name="type">
                        <option value="alternative">可互相替代</option>
                        <option value="complementary">前后互补</option>
                        <option value="contradiction">
                          确认有矛盾，不能同时加载
                        </option>
                        <option value="dismissed">确认不是冲突</option>
                      </select>
                    </label>
                    <label>
                      适用条件与判断依据
                      <input name="reason" required />
                    </label>
                    <button disabled={busy}>确认这两项的关系</button>
                  </form>
                )}
              </details>
            )}
            <div className="cap-entries">
              {view?.items.map((item) => (
                <article key={item.id}>
                  {item.kind !== 'directory' ? (
                    <input
                      aria-label={`选择 ${item.title}`}
                      type="checkbox"
                      checked={selected.includes(item.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, item.id]
                            : selected.filter((id) => id !== item.id),
                        )
                      }
                    />
                  ) : (
                    <Folder className="cap-folder" size={22} />
                  )}
                  <button
                    className="cap-entry"
                    onClick={() =>
                      item.kind === 'directory'
                        ? openDirectory(item.id)
                        : openItem(item.id)
                    }
                  >
                    <strong>{item.title}</strong>
                    <p>{item.description}</p>
                    {search && (
                      <small>{item.path?.map((p) => p.name).join(' / ')}</small>
                    )}
                  </button>
                  <span className="cap-tag">
                    {item.kind === 'directory'
                      ? `目录 · ${item.count?.toLocaleString() ?? 0} 项`
                      : item.kind === 'skill'
                        ? 'Skill'
                        : '工具'}
                    {item.simulated ? ' · 教学样本' : ''}
                    {item.enabled === false ? ' · 停用' : ''}
                  </span>
                  <ChevronRight size={16} />
                </article>
              ))}
              {view?.total === 0 && (
                <p className="cap-empty">
                  当前没有匹配项。可以返回上层选择其他分支，或导入后确认分类。
                </p>
              )}
            </div>
            <div className="cap-row cap-pagination">
              <button
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                上一页
              </button>
              <span>
                {Math.floor(offset / 20) + 1} /{' '}
                {Math.max(1, Math.ceil((view?.total ?? 0) / 20))}
              </span>
              <button
                disabled={view?.nextOffset == null}
                onClick={() => setOffset(view?.nextOffset ?? 0)}
              >
                下一页
              </button>
            </div>
            <details className="cap-new-directory">
              <summary>在此目录新建类别</summary>
              <form
                className="cap-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void run(async () => {
                    await request('/management/directory', {
                      action: 'create',
                      parent: directory,
                      id: crypto.randomUUID(),
                      name: data.get('name'),
                    });
                    setNotice('类别已创建，可在导入或详情中选择。');
                  });
                }}
              >
                <input
                  name="name"
                  required
                  placeholder="类别名称"
                  aria-label="新类别名称"
                />
                <button>新建类别</button>
              </form>
            </details>
          </>
        )}
        {section === 'imports' && (
          <>
            <p className="cap-intro">
              先查看扫描结果和冲突，再决定分类及是否启用。推荐意见不会自动提交。
            </p>
            <BatchImportDecision
              nodes={nodes}
              count={selectedImports.length}
              busy={busy}
              submit={(decision) =>
                run(async () => {
                  const result = await request<{
                    results: { error?: string }[];
                  }>('/management/resolve', { ids: selectedImports, decision });
                  const errors = result.results
                    .filter((r) => r.error)
                    .map((r) => r.error);
                  setSelectedImports([]);
                  if (errors.length) throw new Error(errors.join('；'));
                  setNotice('已处理明确选中的导入项。');
                })
              }
            />
            {pending.map((p) => (
              <ImportDecision
                key={p.id}
                pending={p}
                selected={selectedImports.includes(p.id)}
                select={(checked) =>
                  setSelectedImports(
                    checked
                      ? [...selectedImports, p.id]
                      : selectedImports.filter((id) => id !== p.id),
                  )
                }
                review={() =>
                  run(async () => {
                    await request('/management/compare', { id: p.id, model });
                    setNotice('模型比较已保存为待确认建议。');
                  })
                }
                cancelReview={() =>
                  run(async () => {
                    await request('/management/cancel-comparison', {
                      id: p.id,
                    });
                  })
                }
                nodes={nodes}
                busy={busy}
                onCompare={openItem}
                onResolve={(decision) =>
                  run(async () => {
                    const result = await request<{
                      results: { error?: string }[];
                    }>('/management/resolve', { ids: [p.id], decision });
                    const err = result.results.find((r) => r.error);
                    if (err) throw new Error(err.error);
                    setNotice('已保存本次处理决定。');
                  })
                }
              />
            ))}
            {!pending.length && <p className="cap-empty">没有待处理导入。</p>}
            {pendingTotal > pending.length && (
              <p>当前显示前 20 项，处理后继续显示余下条目。</p>
            )}
          </>
        )}
        {section === 'jobs' && (
          <>
            <p className="cap-intro">
              质量按 1—5
              级逐项评价说明本身；适用项全部覆盖后才计算等权平均。安全单独判断，严重问题不会被平均分抵消。
            </p>
            {jobs.map((job) => (
              <section key={job.id} className="cap-card">
                <div className="cap-row">
                  <strong>
                    {job.kind === 'quality' ? '质量评估' : '安全评估'}
                  </strong>
                  <span>
                    {statusText[job.status]} · {job.completed}/{job.total}
                  </span>
                </div>
                <progress max={job.total} value={job.completed} />
                <p>{job.model ?? '仅规则检查；未进行模型阅读'}</p>
                {job.errors.map((e) => (
                  <p className="cap-warning" key={e}>
                    {e}
                  </p>
                ))}
                {['running', 'queued'].includes(job.status) && (
                  <button
                    onClick={() =>
                      run(async () => {
                        await request('/management/cancel', { id: job.id });
                      })
                    }
                  >
                    取消评估
                  </button>
                )}
              </section>
            ))}
            {!jobs.length && (
              <p className="cap-empty">从目录或能力详情发起第一份独立评估。</p>
            )}
          </>
        )}
      </main>
      {importOpen && (
        <ImportForm
          busy={busy}
          close={() => setImportOpen(false)}
          submit={(body) =>
            run(async () => {
              const imported = await request<{
                results?: { error?: string }[];
              }>('/management/import', body);
              const failures =
                imported.results?.filter((r) => r.error).map((r) => r.error) ??
                [];
              if (failures.length)
                throw new Error(
                  `部分导入失败：${failures.join('；')}；成功项保留在待处理区。`,
                );
              setImportOpen(false);
              setSection('imports');
              setNotice('材料已保存，等待你检查并确认。');
            })
          }
        />
      )}
      {detail && (
        <DetailPanel
          item={detail}
          nodes={nodes}
          busy={busy}
          close={() => setDetail(null)}
          evaluate={(kind) => evaluate(kind, [detail.id])}
          save={(patch) =>
            run(async () => {
              await request(`/management/item/${detail.id}`, patch);
              setDetail(await request<Detail>(`/management/item/${detail.id}`));
              setNotice('管理信息已保存，原文未被改写。');
            })
          }
          refresh={() => openItem(detail.id)}
        />
      )}
    </div>
  );
}
