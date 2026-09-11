'use client';
import { useState } from 'react';
import { X, FileCheck, ShieldCheck } from 'lucide-react';
import type { Directory } from '../../../server/runtime/capabilities/types';
import type { Detail } from './capability-api';
import { Reports } from './capability-reports';
export function DetailPanel({
  item,
  nodes,
  busy,
  close,
  evaluate,
  save,
  refresh,
}: {
  item: Detail;
  nodes: Directory[];
  busy: boolean;
  close: () => void;
  evaluate: (kind: 'quality' | 'safety') => void;
  save: (patch: unknown) => void;
  refresh: () => void;
}) {
  const [tab, setTab] = useState('overview');
  return (
    <div className="cap-overlay">
      <dialog
        open
        className="cap-detail"
        aria-modal="true"
        aria-labelledby="detail-title"
      >
        <header className="cap-row">
          <div>
            <small>
              {item.kind === 'skill' ? 'Skill' : '工具'} ·{' '}
              {item.enabled ? '已启用' : '未启用'}
              {item.simulated ? ' · 教学生成样本' : ''}
            </small>
            <h2 id="detail-title">{item.title}</h2>
          </div>
          <button onClick={close} aria-label="关闭详情">
            <X />
          </button>
        </header>
        <p>{item.description}</p>
        <div className="cap-tabs">
          {[
            ['overview', '说明与原文'],
            ['safety', '安全与权限'],
            ['quality', '质量评估'],
            ['settings', '管理信息'],
          ].map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? 'chosen' : ''}
              onClick={() => setTab(key!)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'overview' && (
          <>
            <p className="cap-meta">
              来源：{item.source}
              <br />
              实际调用名：{item.name}
              <br />
              文件包版本：{item.version}
              <br />
              解析格式：{item.format}
            </p>
            {Object.entries(item.files).map(([name, content]) => (
              <details key={name} open={name === item.entry}>
                <summary>{name}</summary>
                <pre>{content}</pre>
              </details>
            ))}
          </>
        )}
        {tab === 'safety' && (
          <>
            <div className="cap-row">
              <h3>独立安全评估</h3>
              <button disabled={busy} onClick={() => evaluate('safety')}>
                <ShieldCheck size={16} />
                发起评估
              </button>
              <button onClick={refresh}>刷新报告</button>
            </div>
            <p>
              来源{item.trust.verified ? '已核实' : '未核实'} ·{' '}
              {item.trust.trusted ? '用户标记可信' : '未标记可信'}
              。可信标记不授予执行权限。
            </p>
            {item.trust.reason && <p>信任依据：{item.trust.reason}</p>}
            <h4>当前版本扫描</h4>
            <p>
              规则：{item.scan.rules} · 已读 {item.scan.coverage.length} 个文件
              · 语义扫描见独立报告
            </p>
            {!item.scan.findings.length && (
              <p>规则扫描本次未发现线索；这不等于安全证明。</p>
            )}
            {item.scan.findings.map((f, index) => (
              <div className="cap-finding" key={index}>
                <strong>
                  {f.severity === 'block' ? '禁止项' : '待核实'} · {f.reason}
                </strong>
                <small>
                  {f.origin === 'rule' ? '程序规则' : '模型判断'} · {f.file}:
                  {f.line}
                </small>
                <blockquote>{f.evidence}</blockquote>
                <p>{f.suggestion}</p>
              </div>
            ))}
            <h4>权限与依赖</h4>
            {item.permissions.map((p, index) => (
              <p key={index}>
                {p.origin === 'author' ? '作者声明' : '分析推测'}：{p.operation}{' '}
                · {p.target}
              </p>
            ))}
            {item.dependencies.map((d) => (
              <p key={d.name}>
                {d.required ? '必要' : '可选'}依赖：{d.name}
              </p>
            ))}
            {item.compatibility.map((c) => (
              <p className="cap-warning" key={c}>
                {c}
              </p>
            ))}
            <Reports
              reports={item.reports.filter((r) => r.kind === 'safety')}
            />
          </>
        )}
        {tab === 'quality' && (
          <>
            <div className="cap-row">
              <h3>独立质量评估</h3>
              <button disabled={busy} onClick={() => evaluate('quality')}>
                <FileCheck size={16} />
                发起评估
              </button>
              <button onClick={refresh}>刷新报告</button>
            </div>
            <p>
              1 严重不足 · 2 需要较多修改 · 3 基本合格 · 4 良好 · 5
              优秀。评价说明本身，不使用业务任务结果评分。
            </p>
            <Reports
              reports={item.reports.filter((r) => r.kind === 'quality')}
            />
          </>
        )}
        {tab === 'settings' && (
          <>
            <form
              className="cap-form"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                save({
                  title: data.get('title'),
                  description: data.get('description'),
                  directories: data.getAll('directories'),
                  enabled: data.get('enabled') === 'on',
                  trust: {
                    trusted: data.get('trusted') === 'on',
                    scope: data.get('scope'),
                    reason: data.get('reason'),
                    verified: data.get('verified') === 'on',
                    verification: data.get('verification'),
                  },
                });
              }}
            >
              <label>
                显示名称
                <input name="title" defaultValue={item.title} />
              </label>
              <label>
                用途简介
                <textarea name="description" defaultValue={item.description} />
              </label>
              <label>
                分类
                <select
                  multiple
                  name="directories"
                  size={6}
                  defaultValue={item.directories}
                >
                  {nodes
                    .filter((n) => n.id !== 'root')
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {nodes.find((p) => p.id === n.parent)?.name} / {n.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="cap-check">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={item.enabled}
                />
                启用（仍需通过实际执行权限检查）
              </label>
              <label className="cap-check">
                <input
                  type="checkbox"
                  name="trusted"
                  defaultChecked={item.trust.trusted}
                />
                用户标记可信
              </label>
              <label>
                信任范围
                <select name="scope" defaultValue={item.trust.scope ?? 'item'}>
                  <option value="item">当前能力</option>
                  <option value="source">此来源</option>
                </select>
              </label>
              <label>
                信任依据
                <input name="reason" defaultValue={item.trust.reason} />
              </label>
              <label className="cap-check">
                <input
                  type="checkbox"
                  name="verified"
                  defaultChecked={item.trust.verified}
                />
                来源已核实
              </label>
              <label>
                核实记录
                <input
                  name="verification"
                  defaultValue={item.trust.verification}
                />
              </label>
              <button disabled={busy}>保存管理信息</button>
            </form>
            <details>
              <summary>长 Skill：确认共同规则与阶段</summary>
              <p>
                填写包内文件路径。共同规则每个阶段都加载；此配置由你确认，不会根据自动摘要省略要求。
              </p>
              <form
                className="cap-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  try {
                    save({
                      structure: {
                        global: (data.get('global') as string)
                          .split('\n')
                          .map((v) => v.trim())
                          .filter(Boolean),
                        stages: JSON.parse(data.get('stages') as string),
                        confirmed: true,
                      },
                    });
                  } catch {
                    window.alert(
                      '阶段需要合法 JSON，例如 {"检查":["references/check.md"]}',
                    );
                  }
                }}
              >
                <label>
                  共同规则文件（一行一个）
                  <textarea
                    name="global"
                    defaultValue={
                      item.structure?.global.join('\n') ?? item.entry
                    }
                  />
                </label>
                <label>
                  阶段与文件对应关系
                  <textarea
                    name="stages"
                    rows={5}
                    defaultValue={JSON.stringify(
                      item.structure?.stages ?? {},
                      null,
                      2,
                    )}
                  />
                </label>
                <button disabled={busy}>确认分段结构</button>
              </form>
            </details>
            <details>
              <summary>版本与历史评估</summary>
              {item.versions.map((v) => (
                <p key={v.version}>{v.version}</p>
              ))}
              <Reports
                reports={item.history.filter((r) => r.version !== item.version)}
              />
            </details>
          </>
        )}
      </dialog>
    </div>
  );
}
