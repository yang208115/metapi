import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import CenteredModal from '../../components/CenteredModal.js';
import { MobileCard, MobileField } from '../../components/MobileCard.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import type { OperationsRequestsResponse } from '../../../server/shared/operationsContract.js';
import { count, duration, failureLabels, statusLabels, time } from './formatters.js';

export interface EvidenceQuery {
  title: string;
  from: string;
  to: string;
  siteId?: number;
  platform?: string;
  status?: string;
  requestId?: string;
  recovered?: boolean;
}

export default function RequestEvidence({ query, onClose }: { query: EvidenceQuery | null; onClose: () => void }) {
  const isMobile = useIsMobile();
  const [result, setResult] = useState<OperationsRequestsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState('');
  const queryKey = JSON.stringify(query);

  useEffect(() => { setPage(0); setStatus(query?.status ?? ''); }, [queryKey]);
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setResult(null);
    void api.getOperationsRequests({
      from: query.from, to: query.to, siteId: query.siteId, platform: query.platform,
      status: status || undefined, requestId: query.requestId, recovered: query.recovered, limit: 20, offset: page * 20,
    }, controller.signal).then(value => { if (!controller.signal.aborted) setResult(value); }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '请求记录加载失败');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [queryKey, page, status]);

  return <CenteredModal open={!!query} onClose={onClose} title={query?.title ?? '请求结果'} maxWidth={1080}>
    {query && <div className="observatory-evidence">
      <div className="observatory-evidence-toolbar">
        <span>{time(query.from, true)} — {time(query.to, true)} · 每行是一次用户请求的最终结果</span>
        <select aria-label="请求结果筛选" value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}>
          <option value="">全部结果</option>
          {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {error && <div className="observatory-notice is-danger" role="alert">{error}</div>}
      {loading ? <div className="observatory-empty">正在读取请求记录…</div> : result?.items.length === 0 ?
        <div className="observatory-empty">该范围暂无请求结果。新观测启用前的日志不会被推算为用户请求。</div> :
        isMobile ? result?.items.map(row => <MobileCard key={row.requestId} title={row.modelRequested || '未指定模型'} subtitle={time(row.completedAt, true)}>
          <MobileField label="最终结果" value={statusLabels[row.status] ?? row.status} />
          <MobileField label="HTTP / 耗时" value={`${row.httpStatus ?? '—'} · ${duration(row.latencyMs)}`} />
          <MobileField label="尝试 / 失败" value={`${row.attemptCount} / ${row.failedAttemptCount}`} />
          <MobileField label="原因" value={failureLabels[row.errorClass ?? ''] ?? row.errorClass ?? '—'} />
          <MobileField label="请求 ID" value={<code>{row.requestId}</code>} stacked />
        </MobileCard>) : <div className="observatory-table-scroll"><table className="data-table">
          <thead><tr><th>完成时间 / 请求 ID</th><th>模型 / 入口</th><th>结果</th><th>HTTP</th><th>总耗时</th><th>尝试 / 失败</th><th>原因</th></tr></thead>
          <tbody>{result?.items.map(row => <tr key={row.requestId}>
            <td>{time(row.completedAt)}<small className="observatory-row-secondary"><code title={row.requestId}>{row.requestId.slice(0, 16)}…</code></small></td>
            <td>{row.modelRequested || '未指定模型'}<small className="observatory-row-secondary">{row.downstreamPath}</small></td>
            <td><span className={`observatory-result is-${row.status}`}>{statusLabels[row.status] ?? row.status}</span></td>
            <td>{row.httpStatus ?? '—'}</td><td>{duration(row.latencyMs)}</td>
            <td>{row.attemptCount} / {row.failedAttemptCount}</td>
            <td>{failureLabels[row.errorClass ?? ''] ?? row.errorClass ?? '—'}</td>
          </tr>)}</tbody>
        </table></div>}
      {result && <div className="observatory-pagination">
        <span>共 {count(result.total)} 条 · 第 {page + 1} 页</span>
        <button type="button" disabled={page === 0 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
        <button type="button" disabled={(page + 1) * 20 >= result.total || loading} onClick={() => setPage(value => value + 1)}>下一页</button>
      </div>}
    </div>}
  </CenteredModal>;
}
