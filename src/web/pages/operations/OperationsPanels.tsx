import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { MetricDistribution, OperationsSnapshot, OperationsTimelineBucket } from '../../../server/shared/operationsContract.js';
import { formatCompactTokenMetric } from '../../numberFormat.js';
import { attemptLogsLink, count, duration, percent, time } from './formatters.js';
import type { EvidenceQuery } from './RequestEvidence.js';

type EvidenceHandler = (query: EvidenceQuery) => void;

export function evidenceScope(data: OperationsSnapshot): Omit<EvidenceQuery, 'title'> {
  return { from: data.scope.from, to: data.scope.to, siteId: data.scope.siteId ?? undefined, platform: data.scope.platform ?? undefined };
}

export function FocusPanel({ data, openEvidence, stale }: { data: OperationsSnapshot; openEvidence: EvidenceHandler; stale: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const focus = expanded ? data.focus : data.focus.slice(0, 3);
  return <section className="observatory-focus observatory-panel">
    <div className="observatory-section-title"><div><span className="observatory-eyebrow">先看这里</span><h2>故障焦点</h2></div><span className="observatory-tag">基于观测证据</span></div>
    {stale && <p className="observatory-muted">以下为上次成功采集的线索，刷新后再判断当前状态。</p>}
    {data.focus.length ? <div className="observatory-focus-list">{focus.map((item, index) =>
      <article key={item.id} className={`observatory-focus-item is-${item.severity}`}>
        <span className="observatory-focus-index">{String(index + 1).padStart(2, '0')}</span>
        <div><h3>{item.title}</h3><p>{item.evidence}</p><span className="observatory-next">下一步 · {item.action}</span></div>
        {item.kind === 'route' ? <Link className="observatory-text-button" to="/routes">检查路由 ↗</Link> : item.kind === 'attempt' ?
          data.scope.platform && item.siteId == null && data.scope.siteId == null ?
            <div>{data.sites.filter(site => site.failedAttempts > 0).map(site => <Link key={site.id} className="observatory-text-button" to={attemptLogsLink({ ...data.scope, siteId: site.id }, true)}>{site.name} · 尝试 ↗</Link>)}</div> :
            <Link className="observatory-text-button" to={attemptLogsLink({ ...data.scope, siteId: item.siteId ?? data.scope.siteId }, true)}>查看尝试 ↗</Link> :
          item.kind === 'telemetry' ? <a className="observatory-text-button" href="#observatory-confidence">查看覆盖 ↓</a> :
            <button className="observatory-text-button" onClick={() => openEvidence({ ...evidenceScope(data), siteId: item.siteId ?? data.scope.siteId ?? undefined, title: item.title })}>查看请求 ↗</button>}
      </article>)}{data.focus.length > 3 && <button className="observatory-text-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起次要线索 ↑' : `还有 ${data.focus.length - 3} 条观测线索 ↓`}</button>}</div> : <div className="observatory-focus-empty">
      <span className="observatory-status-glyph">{data.current.total ? '✓' : '○'}</span>
      <div><h3>{data.current.total ? '当前窗口未发现需要优先处理的异常' : '等待第一批请求证据'}</h3>
        <p>{data.current.total ? '这描述已采集的请求结果。无流量站点仍需单独验证。' : '请求完成后，将自动聚合失败原因、重试恢复和站点影响。'}</p></div>
    </div>}
  </section>;
}

export function ConfidencePanel({ data, stale, paused, ageSeconds }: { data: OperationsSnapshot; stale: boolean; paused: boolean; ageSeconds: number | null }) {
  const telemetry = data.telemetry;
  const unhealthy = stale || telemetry.writeFailures > 0;
  return <section id="observatory-confidence" className="observatory-panel observatory-confidence">
    <div className="observatory-section-title"><div><span className="observatory-eyebrow">知道数据的边界</span><h2>数据可信度</h2></div>
      <span className={`observatory-tag ${unhealthy ? 'is-danger' : paused || !telemetry.historyComplete ? 'is-warning' : 'is-success'}`}>{stale ? '数据已过期' : telemetry.writeFailures ? '存在采集缺口' : paused ? '已定格' : telemetry.historyComplete ? '时间范围已覆盖' : '覆盖积累中'}</span></div>
    <dl className="observatory-confidence-list">
      <div><dt>快照年龄</dt><dd>{ageSeconds ?? '—'} 秒</dd></div>
      <div><dt>请求观测起点</dt><dd>{telemetry.observedSince ? time(telemetry.observedSince, true) : '尚未采集'}</dd></div>
      <div><dt>总耗时有效样本</dt><dd>{percent(telemetry.latencyCoverage)} <small>({count(data.latency.count)} 条)</small></dd></div>
      <div><dt>首块时延有效样本</dt><dd>{percent(telemetry.firstByteCoverage)} <small>({count(data.firstByte.count)} 条)</small></dd></div>
      <div><dt>未归属站点请求</dt><dd>{count(telemetry.unassignedRequests)}</dd></div>
      <div><dt>待写入 / 写入失败</dt><dd className={telemetry.writeFailures ? 'observatory-danger' : ''}>{telemetry.pendingWrites} / {telemetry.writeFailures}</dd></div>
    </dl>
    <p className="observatory-small">旧尝试日志不推算为用户请求；缺失样本不计为零延迟。</p>
    {telemetry.notes.length > 0 && <details className="observatory-notes"><summary>观测范围说明（{telemetry.notes.length}）</summary>{telemetry.notes.map((note, index) => <p key={index}>{note}</p>)}</details>}
  </section>;
}

function changeLabel(current: number, previous: number): string {
  if (!previous) return current ? '上个窗口无样本' : '两个窗口均无请求';
  const difference = ((current - previous) / previous) * 100;
  return `较上个窗口 ${difference >= 0 ? '+' : ''}${difference.toFixed(1)}%`;
}

export function RequestMetrics({ data, openEvidence }: { data: OperationsSnapshot; openEvidence: EvidenceHandler }) {
  const current = data.current;
  const comparable = data.telemetry.historyComplete && data.telemetry.writeFailures === 0;
  const cards = [
    { label: '用户请求', value: count(current.total), detail: comparable ? changeLabel(current.total, data.previous.total) : '历史覆盖不足，暂不比较变化', note: '一次入口请求，只记一次最终结果', status: undefined },
    { label: '最终成功率', value: percent(current.successRate), detail: `${count(current.success)} 成功 / ${count(current.total)} 请求`, note: '不静默排除 429、529；取消与未知也列入总数', status: 'success' },
    { label: '失败请求', value: count(current.failed), detail: `${current.rejected} 拒绝 · ${current.cancelled} 取消 · ${current.unknown} 未知`, note: '失败、拒绝、取消和未知分别保留', status: 'failed' },
    { label: '重试挽回', value: count(current.recoveredRequests), detail: `${count(current.retryRequests)} 个请求发生重试`, note: '上游尝试失败后，最终仍完整成功', status: 'success', recovered: true },
  ];
  return <section className="observatory-metrics" aria-label="用户请求统计">{cards.map((card, index) => <button key={card.label} className={`observatory-metric ${index === 2 && current.failed ? 'is-alert' : ''}`} onClick={() => openEvidence({ ...evidenceScope(data), title: card.label, status: card.status, recovered: card.recovered })}>
    <span className="observatory-metric-label">{card.label}<span aria-hidden="true">↗</span></span>
    <strong>{card.value}</strong><span className="observatory-metric-detail">{card.detail}</span><small>{card.note}</small>
  </button>)}</section>;
}

export function TrafficPanel({ data, liveWindow, onLiveWindow, openEvidence }: {
  data: OperationsSnapshot; liveWindow: number; onLiveWindow: (minutes: number) => void; openEvidence: EvidenceHandler;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...data.timeline.map(bucket => bucket.requests));
  const active = hovered == null ? null : data.timeline[hovered];
  const bucketLabel = (bucket: OperationsTimelineBucket) => `${time(bucket.from, true)} 至 ${time(bucket.to)}：${bucket.requests} 次请求，${bucket.failed} 失败，${bucket.rejected} 拒绝，${bucket.cancelled} 取消`;
  return <section className="observatory-panel observatory-traffic">
    <div className="observatory-section-title"><div><span className="observatory-eyebrow">用户结果 × 上游尝试</span><h2>流量与失败时间线</h2></div><span className="observatory-small">点击时间片，直接复盘</span></div>
    <div className="observatory-timeline-caption" aria-live="polite">{active ? bucketLabel(active) : `${time(data.scope.from, true)} — ${time(data.scope.to, true)} · 每个色柱代表一段实际观测`}</div>
    <div className="observatory-timeline" role="group" aria-label="请求时间线">
      {data.timeline.map((bucket, index) => <button key={bucket.from} aria-label={bucketLabel(bucket)} title={bucketLabel(bucket)} onMouseEnter={() => setHovered(index)} onFocus={() => setHovered(index)} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)}
        onClick={() => openEvidence({ ...evidenceScope(data), from: bucket.from, to: bucket.to, title: '时间片复盘' })}>
        <span className="observatory-timeline-bar" style={{ height: `${bucket.requests / max * 100}%` }}>
          <span className="observatory-timeline-fail" style={{ height: `${bucket.requests ? bucket.failed / bucket.requests * 100 : 0}%` }} />
          <span className="observatory-timeline-reject" style={{ height: `${bucket.requests ? (bucket.rejected + bucket.cancelled) / bucket.requests * 100 : 0}%` }} />
        </span>
      </button>)}
    </div>
    <div className="observatory-chart-labels"><span>{time(data.scope.from, true)}</span><span className="observatory-chart-legend"><i />请求 <i className="is-danger" />失败 <i className="is-warning" />拒绝 / 取消</span><span>{time(data.scope.to, true)}</span></div>
    <div className="observatory-live-heading"><h3>短窗口吞吐</h3><div className="observatory-segments" aria-label="吞吐采样窗口">{[1, 5, 30, 60].map(minutes => <button key={minutes} aria-pressed={liveWindow === minutes} className={liveWindow === minutes ? 'active' : ''} onClick={() => onLiveWindow(minutes)}>{minutes === 60 ? '1h' : `${minutes}m`}</button>)}</div></div>
    <div className="observatory-live-grid">
      <div><span>平均完成速率</span><strong>{data.live.qps.toFixed(2)} <small>请求/s</small></strong></div>
      <div><span>峰值 · {data.live.bucketSeconds}s 桶</span><strong>{data.live.peakQps.toFixed(2)} <small>请求/s</small></strong></div>
      <div><span>已记录用量吞吐</span><strong>{data.live.tokensPerSecond.toFixed(1)} <small>tokens/s</small></strong></div>
      <div><span>本进程在途 · 全部站点</span><strong>{count(data.telemetry.inFlight)} <small>请求</small></strong></div>
    </div>
    <p className="observatory-small">吞吐窗口 {time(data.live.from)} — {time(data.live.to)} · {count(data.live.requests)} 个完成请求 / {formatCompactTokenMetric(data.live.tokens)} Tokens。Token 吞吐不等于单请求生成速度。</p>
  </section>;
}

function Distribution({ name, description, value }: { name: string; description: string; value: MetricDistribution }) {
  return <div className="observatory-distribution"><div><h3>{name}</h3><p>{description}</p></div><strong>{duration(value.p95)} <small>P95</small></strong>
    <dl>{(['average', 'p50', 'p90', 'max'] as const).map((key, index) => <div key={key}><dt>{['平均', 'P50', 'P90', '最大'][index]}</dt><dd>{duration(value[key])}</dd></div>)}</dl>
    <span className="observatory-small">{count(value.count)} 个有效样本 · 与主窗口一致</span></div>;
}

export function LatencyPanel({ data }: { data: OperationsSnapshot }) {
  return <section className="observatory-panel observatory-latency"><div className="observatory-section-title"><div><span className="observatory-eyebrow">长尾比均值更值得注意</span><h2>响应分布</h2></div></div>
    <Distribution name="请求总耗时" description="从入口到最终结束，包含重试等待" value={data.latency} />
    <Distribution name="上游首块时延" description="首个响应数据块，不等同于首个有效 Token" value={data.firstByte} />
  </section>;
}

export function SitesPanel({ data, openEvidence }: { data: OperationsSnapshot; openEvidence: EvidenceHandler }) {
  const [onlyAttention, setOnlyAttention] = useState(false);
  const sites = data.sites.filter(site => !onlyAttention || site.requests.failed || site.requests.rejected || site.requests.cancelled || site.requests.unknown || site.failedAttempts || site.readyChannels === 0);
  return <section className="observatory-panel observatory-sites"><div className="observatory-section-title"><div><span className="observatory-eyebrow">从症状找到站点</span><h2>站点观测矩阵 <small>{sites.length}</small></h2></div>
    <label className="observatory-check"><input type="checkbox" checked={onlyAttention} onChange={event => setOnlyAttention(event.target.checked)} />只看需关注</label></div>
    <p className="observatory-small">失败优先排列，包含无流量和已停用站点。可选通道由配置与冷却状态判断，不代表刚完成主动探测。</p>
    {sites.length ? <div className="observatory-site-grid">{sites.map(site => <article key={site.id} className={`observatory-site ${site.requests.failed || site.failedAttempts ? 'has-failure' : ''}`}>
      <div className="observatory-site-title"><div><h3>{site.name}</h3><span>{site.platform} · {site.status === 'active' ? '启用' : '已停用'}</span></div><button className="observatory-text-button" onClick={() => openEvidence({ ...evidenceScope(data), siteId: site.id, title: `${site.name} · 请求结果` })}>请求 ↗</button></div>
      <div className="observatory-site-numbers"><strong>{percent(site.requests.successRate)}<small>最终成功率</small></strong><span>{count(site.requests.total)}<small>用户请求</small></span><span className={site.requests.failed ? 'observatory-danger' : ''}>{count(site.requests.failed)}<small>失败</small></span></div>
      <div className="observatory-site-strip" aria-label={`${site.name} 分时尝试结果`}>{site.buckets.map((bucket, index) => <span key={index} className={!bucket.total ? 'is-empty' : bucket.failed ? 'is-failed' : 'is-success'} title={`${bucket.total} 次尝试 / ${bucket.failed} 次失败`} />)}</div>
      <dl className="observatory-site-details"><div><dt>上游尝试 / 失败</dt><dd>{site.attempts} / {site.failedAttempts}</dd></div><div><dt>请求 P95</dt><dd>{duration(site.latency.p95)}</dd></div><div><dt>可选 / 全部通道</dt><dd>{site.readyChannels} / {site.channels}</dd></div><div><dt>冷却通道</dt><dd>{site.coolingChannels}</dd></div><div><dt>活跃 / 全部账户</dt><dd>{site.activeAccounts} / {site.accounts}</dd></div></dl>
      <Link className="observatory-text-button" to={attemptLogsLink({ ...data.scope, siteId: site.id })}>查看该窗口的尝试日志 →</Link>
    </article>)}</div> : <div className="observatory-empty">{onlyAttention ? '没有符合条件的站点' : '当前范围没有站点。未归属站点的请求仍保留在全局统计中。'}</div>}
  </section>;
}
