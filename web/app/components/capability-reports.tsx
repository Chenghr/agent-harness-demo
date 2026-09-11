import type { Report } from '../../../server/runtime/capabilities/types';
import { riskText } from './capability-api';
export function Reports({ reports }: { reports: Report[] }) {
  if (!reports.length)
    return <p className="cap-empty">当前版本尚无这类评估报告。</p>;
  return (
    <>
      {[...reports].reverse().map((report) => (
        <section className="cap-card" key={report.id}>
          <div className="cap-row">
            <strong>
              {report.kind === 'quality'
                ? report.overall == null
                  ? '未覆盖全部适用维度'
                  : `${report.overall.toFixed(1)} / 5`
                : riskText[report.risk ?? 'insufficient']}
            </strong>
            <small>
              {report.model ?? '规则检查'} ·{' '}
              {new Date(report.date).toLocaleString('zh-CN')}
            </small>
          </div>
          {report.grades?.map((g) => (
            <div className="cap-grade" key={g.dimension}>
              <strong>
                {g.dimension}{' '}
                <span>
                  {g.status === 'scored'
                    ? `${g.score} / 5`
                    : g.status === 'uncovered'
                      ? '未覆盖'
                      : '不适用'}
                </span>
              </strong>
              <p>{g.reason}</p>
              {g.evidence.map((e, index) => (
                <blockquote key={index}>
                  {e.file}:{e.line} · {e.quote}
                </blockquote>
              ))}
              <p>{g.suggestion}</p>
            </div>
          ))}
          {report.sections?.map((s, index) => (
            <div key={index}>
              <h4>{s.title}</h4>
              <p>{s.judgment}</p>
              {s.evidence.map((e, i) => (
                <blockquote key={i}>
                  {e.file}:{e.line} · {e.quote}
                </blockquote>
              ))}
              <p>{s.suggestion}</p>
            </div>
          ))}
          {report.critical.map((c) => (
            <p className="cap-warning" key={c}>
              优先处理：{c}
            </p>
          ))}
          {report.gaps.length > 0 && (
            <p className="cap-warning">未覆盖：{report.gaps.join('、')}</p>
          )}
          <small>
            规则 {report.rules} · 文件包 {report.version.slice(0, 12)} · 检查{' '}
            {report.coverage.length} 个文件
          </small>
        </section>
      ))}
    </>
  );
}
