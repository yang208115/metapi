import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import type { OperationsWindow } from '../../server/shared/operationsContract.js';
import ResponsiveFilterPanel from '../components/ResponsiveFilterPanel.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { formatCompactTokenMetric } from '../numberFormat.js';
import BusinessAnalysis from './operations/BusinessAnalysis.js';
import RequestEvidence, { type EvidenceQuery } from './operations/RequestEvidence.js';
import { ConfidencePanel, evidenceScope, FocusPanel, LatencyPanel, RequestMetrics, SitesPanel, TrafficPanel } from './operations/OperationsPanels.js';
import { count, duration, failureLabels, statusLabels, time } from './operations/formatters.js';
import { useOperationsSnapshot } from './operations/useOperationsSnapshot.js';
import './operations/operations.css';

export default function Dashboard({ adminName = '管理员' }: { adminName?: string }) {
  const isMobile = useIsMobile();
  const [windowMinutes, setWindowMinutes] = useState<OperationsWindow>(1440);
  const [liveWindowMinutes, setLiveWindowMinutes] = useState(5);
  const [siteId, setSiteId] = useState<number | undefined>();
  const [platform, setPlatform] = useState<string | undefined>();
  const [paused, setPaused] = useState(false);
  const [mobileFilters, setMobileFilters] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceQuery | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const { data, filters, loading, error, refresh, ageSeconds, stale } = useOperationsSnapshot({ windowMinutes, liveWindowMinutes, siteId, platform }, paused);
  const closeEvidence = useCallback(() => setEvidence(null), []);
  const refreshAll = () => { refresh(); setRefreshRevision(value => value + 1); };
  const filterFields = <div className="observatory-filters">
    <label>站点<select aria-label="站点筛选" value={siteId ?? ''} onChange={event => setSiteId(event.target.value ? Number(event.target.value) : undefined)}>
      <option value="">全部站点（含未归属请求）</option>{filters.filter(site => !platform || site.platform === platform).map(site => <option value={site.id} key={site.id}>{site.name}{site.status === 'active' ? '' : ' · 已停用'}</option>)}
    </select></label>
    <label>平台<select aria-label="平台筛选" value={platform ?? ''} onChange={event => { setPlatform(event.target.value || undefined); setSiteId(undefined); }}>
      <option value="">全部平台</option>{[...new Set(filters.map(site => site.platform))].filter(Boolean).map(value => <option key={value} value={value}>{value}</option>)}
    </select></label>
    <label>主观测窗口<select aria-label="主观测窗口" value={windowMinutes} onChange={event => setWindowMinutes(Number(event.target.value) as OperationsWindow)}>
      <option value={60}>滚动 1 小时</option><option value={1440}>滚动 24 小时</option><option value={10080}>滚动 7 天</option>
    </select></label>
  </div>;
  const scopeName = siteId ? filters.find(site => site.id === siteId)?.name ?? '所选站点' : platform || '全部站点';
  const failed = data ? data.current.failed + data.current.rejected + data.current.cancelled + data.current.unknown : 0;
  const status = error || stale ? '观测数据需要更新' : !data ? '正在建立观测' : !data.current.total ? '尚无请求样本' : failed ? '发现需关注的请求' : '已采集请求未见失败';

  return <div className="observatory animate-fade-in">
    <header className="observatory-header">
      <div><span className="observatory-eyebrow">METAPI / OPERATIONS</span><h1>运维监控<span className="observatory-version">观测 · 定位 · 复盘</span></h1><p>{adminName}，从请求结果看服务，从尝试记录找原因。</p></div>
      <div className="observatory-header-actions"><button className={`observatory-button ${paused ? 'is-selected' : ''}`} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? '▶ 恢复实时' : 'Ⅱ 定格复盘'}</button>
        <button className="observatory-button is-primary" onClick={refreshAll} disabled={loading}>{loading ? '更新中…' : '刷新数据'}</button></div>
    </header>

    <div className="observatory-toolbar"><ResponsiveFilterPanel isMobile={isMobile} mobileOpen={mobileFilters} onMobileOpen={() => setMobileFilters(true)} onMobileClose={() => setMobileFilters(false)} mobileTitle="观测范围" mobileContent={filterFields} desktopContent={filterFields} mobileTriggerLabel={`${scopeName} · 更改范围`} />
      <span className="observatory-auto-label"><i className={paused ? 'is-paused' : ''} />{paused ? '已暂停自动刷新' : '每 30 秒更新'}</span></div>

    {error && <div className="observatory-notice is-danger" role="alert"><strong>数据刷新失败</strong><span>{error}。{data ? '保留上次成功的快照，当前状态未知。' : '没有用其他范围的数据替代。'}</span><button onClick={refreshAll}>重试</button></div>}
    {paused && data && <div className="observatory-notice is-frozen"><strong>复盘已定格</strong><span>保留 {time(data.generatedAt, true)} 的快照。可以点击时间片和指标查看证据；更改筛选会生成新的快照。</span></div>}
    {!data ? <section className="observatory-panel observatory-loading" aria-busy={loading}><span className={loading ? 'spinner' : ''} /><h2>{loading ? '正在汇合请求与尝试数据' : '暂时无法建立观测'}</h2><p>所有核心指标使用同一个时间边界和站点范围。</p>{!loading && <button className="observatory-button" onClick={refreshAll}>重新加载</button>}</section> : <>
      <div className="observatory-scope-line"><span className={`observatory-state ${stale ? 'is-unknown' : failed ? 'is-warning' : data.current.total ? 'is-success' : 'is-unknown'}`}><i />{status}</span><span>{scopeName} · {time(data.scope.from, true)} — {time(data.scope.to, true)} · {data.scope.timezone}</span></div>
      <RequestMetrics data={data} openEvidence={setEvidence} />
      <div className="observatory-insight-grid"><FocusPanel data={data} openEvidence={setEvidence} stale={stale} /><ConfidencePanel data={data} stale={stale} paused={paused} ageSeconds={ageSeconds} /></div>
      <div className="observatory-analysis-grid"><TrafficPanel data={data} liveWindow={liveWindowMinutes} onLiveWindow={setLiveWindowMinutes} openEvidence={setEvidence} /><LatencyPanel data={data} /></div>

      <section className="observatory-attempt-strip" aria-label="上游尝试统计"><div><span>上游尝试</span><strong>{count(data.attempts.total)}</strong><small>重试各自计数</small></div><div><span>失败尝试</span><strong className={data.attempts.failed ? 'observatory-danger' : ''}>{count(data.attempts.failed)}</strong><small>不等于用户最终失败</small></div><div><span>429 限流</span><strong>{count(data.attempts.rateLimited)}</strong><small>保留在尝试失败中</small></div><div><span>上游 5xx</span><strong>{count(data.attempts.serverErrors)}</strong><small>包括 529</small></div><div><span>已记录 Tokens</span><strong>{formatCompactTokenMetric(data.attempts.tokens)}</strong><small>未知用量不补造</small></div></section>

      <SitesPanel data={data} openEvidence={setEvidence} />

      <section className="observatory-panel observatory-recent"><div className="observatory-section-title"><div><span className="observatory-eyebrow">结果可追溯</span><h2>最近异常请求</h2></div><button className="observatory-text-button" onClick={() => setEvidence({ ...evidenceScope(data), title: '全部请求结果' })}>查看全部请求 ↗</button></div>
        {data.recentFailures.length ? <div className="observatory-recent-list">{data.recentFailures.map(item => <button className="observatory-recent-row" key={item.requestId} onClick={() => setEvidence({ ...evidenceScope(data), title: '请求结果详情', requestId: item.requestId })}>
          <span className="observatory-recent-time">{time(item.completedAt)}</span><span><strong>{item.model || '未指定模型'}</strong><small>{item.siteId == null ? '未归属站点' : filters.find(site => site.id === item.siteId)?.name ?? `站点 #${item.siteId}`}</small></span><span className="observatory-recent-reason">{failureLabels[item.errorClass ?? ''] ?? item.errorClass ?? statusLabels[item.status] ?? item.status}</span><span>{item.httpStatus ?? '—'}</span><span>{duration(item.latencyMs)}</span><span className="observatory-small">{item.attemptCount} 次尝试 ↗</span>
        </button>)}</div> : <div className="observatory-empty">当前窗口没有已采集的异常请求。</div>}
      </section>
    </>}

    <BusinessAnalysis siteId={siteId} platform={platform} paused={paused} refreshRevision={refreshRevision} />
    <footer className="observatory-footer"><span>请求结果用于判断影响，尝试日志用于定位原因。</span><nav><Link to="/routes">路由管理</Link><Link to="/settings/notify">通知设置</Link><Link to="/logs">尝试日志</Link></nav></footer>
    <RequestEvidence query={evidence} onClose={closeEvidence} />
  </div>;
}
