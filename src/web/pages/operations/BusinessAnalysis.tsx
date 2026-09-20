import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { time } from './formatters.js';

const SiteDistributionChart = lazy(() => import('../../components/charts/SiteDistributionChart.js'));
const SiteTrendChart = lazy(() => import('../../components/charts/SiteTrendChart.js'));
const ModelAnalysisPanel = lazy(() => import('../../components/ModelAnalysisPanel.js'));

export default function BusinessAnalysis({ siteId, platform, paused, refreshRevision }: {
  siteId?: number; platform?: string; paused: boolean; refreshRevision: number;
}) {
  const [days, setDays] = useState(7);
  const [result, setResult] = useState<{ key: string; sites: Awaited<ReturnType<typeof api.getSiteSnapshot>>; insights: any } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify({ days, siteId, platform });
  const lastLoad = useRef({ key: '', revision: -1 });
  useEffect(() => {
    let disposed = false;
    let running = false;
    const load = async (refresh = false) => {
      if (running) return;
      running = true;
      setLoading(true);
      try {
        const options = { days, siteId, platform, refresh };
        const [sites, insights] = await Promise.all([api.getSiteSnapshot(days, options), api.getDashboardInsights(options)]);
        if (!disposed) { setResult({ key, sites, insights }); setError(null); }
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : '业务分析加载失败');
      } finally { running = false; if (!disposed) setLoading(false); }
    };
    if (!paused || lastLoad.current.key !== key || lastLoad.current.revision !== refreshRevision) {
      lastLoad.current = { key, revision: refreshRevision };
      void load(refreshRevision > 0);
    } else {
      setLoading(false);
    }
    const timer = setInterval(() => {
      if (!paused && document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [key, paused, refreshRevision]);
  const data = result?.key === key ? result : null;
  return <section className="observatory-business">
    <div className="observatory-section-title"><div><span className="observatory-eyebrow">同一站点范围 · 独立自然日窗口</span><h2>使用与消耗</h2></div>
      <div className="observatory-segments" aria-label="业务分析范围">{[7, 30, 90].map(value => <button key={value} aria-pressed={days === value} className={days === value ? 'active' : ''} onClick={() => setDays(value)}>{value} 天</button>)}</div></div>
    <p className="observatory-small">调用以历史尝试日志聚合；金额是记录或估算的代理消耗，不代表上游账单。余额是保存快照；历史聚合可能沿用旧估算口径，未自动重算。{data?.sites.generatedAt && `站点数据：${time(data.sites.generatedAt, true)}`} {data?.insights.generatedAt && `· 模型数据：${time(data.insights.generatedAt, true)}`}{loading ? ' · 更新中…' : ''}</p>
    {error && <div className="observatory-notice is-warning" role="alert">业务分析刷新失败：{error}。{data ? '以下保留上次快照。' : '暂无可显示的数据。'}</div>}
    {data ? <Suspense fallback={<div className="observatory-empty">正在加载业务图表…</div>}>
      <div className="observatory-business-grid"><SiteDistributionChart data={data.sites.distribution} loading={false} /><SiteTrendChart data={data.sites.trend} loading={false} /></div>
      <div className="observatory-panel observatory-models"><div className="observatory-section-title"><h3>模型分析 · 近 {days} 天</h3><span className="observatory-small">分布含其他模型，均值按有效样本计算</span></div><ModelAnalysisPanel data={data.insights.modelAnalysis} /></div>
    </Suspense> : loading && <div className="observatory-empty">正在读取业务统计…</div>}
  </section>;
}
