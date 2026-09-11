'use client';
import { useState } from 'react';
import { X } from 'lucide-react';
import type {
  Pending,
  Directory,
} from '../../../server/runtime/capabilities/types';
import { conflictText, request } from './capability-api';
export function ImportForm({
  busy,
  close,
  submit,
}: {
  busy: boolean;
  close: () => void;
  submit: (body: unknown) => void;
}) {
  const [files, setFiles] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  async function choose(list: FileList | null) {
    if (!list) return;
    setError('');
    try {
      const selected = Array.from(list);
      if (selected.reduce((n, f) => n + f.size, 0) > 4_000_000)
        throw new Error('文件包不能超过 4 MB');
      const values = await Promise.all(
        selected.map(async (file) => {
          const relative = file.webkitRelativePath;
          const name = relative
            ? relative.split('/').slice(1).join('/')
            : file.name;
          return [name, await file.text()] as const;
        }),
      );
      setFiles(Object.fromEntries(values));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="cap-overlay">
      <dialog
        open
        className="cap-modal"
        aria-modal="true"
        aria-labelledby="import-title"
      >
        <div className="cap-row">
          <h2 id="import-title">导入能力</h2>
          <button onClick={close} aria-label="关闭导入">
            <X />
          </button>
        </div>
        <p>
          保留原文件包。支持 SKILL.md、普通 Markdown，以及明确标为
          harness-capability-v1 的 JSON / YAML。导入时不会执行脚本。选择包含多个
          SKILL.md 子目录的文件夹时，会分为独立导入项。
        </p>
        <form
          className="cap-form"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const roots = Object.keys(files)
              .filter((name) => name.endsWith('/SKILL.md'))
              .map((name) => name.slice(0, -'SKILL.md'.length));
            if (
              data.get('kind') === 'skill' &&
              !files['SKILL.md'] &&
              roots.length > 1
            ) {
              submit({
                packages: roots.map((root) => ({
                  kind: 'skill',
                  source: data.get('source'),
                  files: Object.fromEntries(
                    Object.entries(files)
                      .filter(
                        ([name]) =>
                          name.startsWith(root) &&
                          !roots.some(
                            (other) =>
                              other !== root &&
                              other.startsWith(root) &&
                              name.startsWith(other),
                          ),
                      )
                      .map(([name, content]) => [
                        name.slice(root.length),
                        content,
                      ]),
                  ),
                })),
              });
            } else
              submit({
                kind: data.get('kind'),
                source: data.get('source'),
                files,
              });
          }}
        >
          <label>
            能力类型
            <select name="kind">
              <option value="skill">Skill 工作说明</option>
              <option value="tool">工具定义（待绑定执行器）</option>
            </select>
          </label>
          <label>
            实际来源
            <input
              name="source"
              required
              placeholder="例如：团队仓库路径、下载地址或本机目录"
            />
          </label>
          <label>
            选择文件
            <input
              type="file"
              multiple
              onChange={(e) => choose(e.target.files)}
            />
          </label>
          <label>
            或选择整个文件夹
            <input
              type="file"
              multiple
              {...{ webkitdirectory: '' }}
              onChange={(e) => choose(e.target.files)}
            />
          </label>
          <p>
            {Object.keys(files).length} 个文件 ·{' '}
            {(
              Object.values(files).reduce((n, v) => n + v.length, 0) / 1024
            ).toFixed(1)}{' '}
            KB 文本
          </p>
          {error && <p role="alert">{error}</p>}
          <button
            className="cap-primary"
            disabled={busy || !Object.keys(files).length}
          >
            扫描并进入待处理区
          </button>
        </form>
      </dialog>
    </div>
  );
}
export function ImportDecision({
  pending: p,
  nodes,
  busy,
  onResolve,
  onCompare,
  selected,
  select,
  review,
  cancelReview,
}: {
  selected: boolean;
  select: (checked: boolean) => void;
  review: () => void;
  cancelReview: () => void;
  pending: Pending;
  nodes: Directory[];
  busy: boolean;
  onResolve: (decision: unknown) => void;
  onCompare: (id: string) => void;
}) {
  const recommended = p.conflicts.some((c) => c.type === 'duplicate')
    ? 'skip'
    : p.conflicts.some((c) => c.type === 'update')
      ? 'replace'
      : 'keep';
  return (
    <section className="cap-card">
      <div className="cap-row">
        <label className="cap-check">
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => select(e.target.checked)}
            aria-label={`选择导入 ${p.record.title}`}
          />
          <strong>{p.record.title}</strong>
        </label>
        <span>
          {p.record.source} · {p.record.version.slice(0, 10)}
        </span>
      </div>
      <p>{p.record.description}</p>
      <PendingMaterials id={p.id} />
      <div className="cap-row">
        <button disabled={busy} onClick={review}>
          用所选模型比较候选
        </button>
        {busy && <button onClick={cancelReview}>取消本项模型比较</button>}
      </div>
      <details>
        <summary>本次新材料的原始声明与检查覆盖</summary>
        <pre>{JSON.stringify(p.record.claims, null, 2)}</pre>
        <p>{p.record.scan.coverage.join('、')}</p>
      </details>
      {p.conflicts.map((c, index) => (
        <div className="cap-conflict" key={`${c.otherId}-${index}`}>
          <strong>{conflictText[c.type]}</strong>
          <p>{c.suggestion}</p>
          <blockquote>{c.evidence.join('\n')}</blockquote>
          <button onClick={() => onCompare(c.otherId)}>
            查看已有版本 {c.otherVersion.slice(0, 8)}
          </button>
        </div>
      ))}
      {p.record.scan.findings.map((f, index) => (
        <p key={index} className="cap-warning">
          {f.file}:{f.line} · {f.reason}
        </p>
      ))}
      {p.record.compatibility.map((c) => (
        <p key={c}>{c}</p>
      ))}
      <form
        className="cap-form"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          onResolve({
            action: data.get('action'),
            directories: data.getAll('directories'),
            displayName: data.get('displayName'),
            reason: data.get('reason'),
          });
        }}
      >
        <label>
          处理方式
          <select name="action" defaultValue={recommended}>
            <option value="keep">保留并存，确认后启用</option>
            <option value="replace">审查后启用新版，保留旧版记录</option>
            <option value="save-disabled">仅保存，暂不启用</option>
            <option value="skip">跳过本次导入</option>
            <option value="attach-source">重复内容补记来源</option>
            <option value="dismiss">确认不是冲突，保留并存</option>
          </select>
        </label>
        <label>
          分类（可多选）
          <select name="directories" multiple size={5}>
            {nodes
              .filter((n) => n.id !== 'root')
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {nodes.find((p) => p.id === n.parent)?.name} / {n.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          显示名称（可选）
          <input name="displayName" defaultValue={p.record.title} />
        </label>
        <label>
          处理依据
          <input name="reason" placeholder="例如：用途互补，保留两份" />
        </label>
        <button disabled={busy}>确认本项处理</button>
      </form>
    </section>
  );
}
export function BatchImportDecision({
  nodes,
  count,
  busy,
  submit,
}: {
  nodes: Directory[];
  count: number;
  busy: boolean;
  submit: (decision: unknown) => void;
}) {
  return (
    <details className="cap-card">
      <summary>批量处理选中导入（{count} 项）</summary>
      <form
        className="cap-form"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          submit({
            action: data.get('action'),
            directories: data.getAll('directories'),
            reason: data.get('reason'),
          });
        }}
      >
        <label>
          处理方式
          <select name="action">
            <option value="keep">保留并存</option>
            <option value="skip">跳过选中项</option>
            <option value="save-disabled">保存但不启用</option>
            <option value="replace">启用新版，保留旧版</option>
          </select>
        </label>
        <label>
          确认分类
          <select multiple name="directories" size={4}>
            {nodes
              .filter((n) => n.id !== 'root')
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {nodes.find((p) => p.id === n.parent)?.name} / {n.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          处理依据
          <input name="reason" />
        </label>
        <button disabled={busy || !count}>只处理选中的 {count} 项</button>
      </form>
    </details>
  );
}

function PendingMaterials({ id }: { id: string }) {
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  return (
    <div className="cap-pending-materials">
      <button
        disabled={loading}
        onClick={() => {
          setLoading(true);
          void request<{ files: Record<string, string> }>(
            `/management/import/${id}`,
          )
            .then((data) => setFiles(data.files))
            .catch((error: Error) => setError(error.message))
            .finally(() => setLoading(false));
        }}
      >
        {loading ? '正在读取…' : '查看本次导入的完整原文'}
      </button>
      {error && <p role="alert">{error}</p>}
      {files && (
        <>
          <button onClick={() => setFiles(null)}>收起原文</button>
          {Object.entries(files).map(([file, content]) => (
            <details key={file} open={file === 'SKILL.md'}>
              <summary>{file}</summary>
              <pre>{content}</pre>
            </details>
          ))}
        </>
      )}
    </div>
  );
}
