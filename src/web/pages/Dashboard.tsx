import { Suspense, lazy, useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.js";
import { useIsMobile } from "../components/useIsMobile.js";
import { formatCompactTokenMetric } from "../numberFormat.js";

const ModelAnalysisPanel = lazy(
  () => import("../components/ModelAnalysisPanel.js"),
);
const SiteDistributionChart = lazy(
  () => import("../components/charts/SiteDistributionChart.js"),
);
const SiteTrendChart = lazy(
  () => import("../components/charts/SiteTrendChart.js"),
);

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "🌙 夜深了";
  if (hour < 11) return "☀️ 早上好";
  if (hour < 13) return "👋 中午好";
  if (hour < 18) return "🌤️ 下午好";
  return "🌙 晚上好";
}

function safeNumber(value: unknown): number {
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    !Number.isFinite(value)
  )
    return 0;
  return value;
}

function ChartFallback({ height = 280 }: { height?: number }) {
  return (
    <div className="card" style={{ minHeight: height, padding: 16 }}>
      <div
        className="skeleton"
        style={{ width: 160, height: 18, marginBottom: 12 }}
      />
      <div
        className="skeleton"
        style={{
          width: "100%",
          height: Math.max(120, height - 46),
          borderRadius: 10,
        }}
      />
    </div>
  );
}

type SiteSpeedState =
  | { status: "loading" }
  | { status: "timeout" }
  | { status: "done"; ms: number }
  | undefined;

type SiteAvailabilityBucket = {
  startUtc?: string | null;
  label: string;
  totalRequests: number;
  successCount: number;
  failedCount: number;
  availabilityPercent: number | null;
  averageLatencyMs: number | null;
};

type SiteAvailabilitySummary = {
  siteId: number;
  siteName: string;
  siteUrl?: string | null;
  platform?: string | null;
  totalRequests: number;
  successCount: number;
  failedCount: number;
  availabilityPercent: number | null;
  averageLatencyMs: number | null;
  buckets: SiteAvailabilityBucket[];
};

type DashboardWindowMetrics = {
  windowMinutes: number;
  totalCount: number;
  successCount: number;
  failedCount: number;
  businessLimitCount: number;
  totalTokensAll: number;
  averageLatencyMs: number | null;
  averageFirstByteLatencyMs: number | null;
  peakQps: number;
  buckets: Array<{
    requestCount: number;
    successCount: number;
    failedCount: number;
    businessLimitCount: number;
    totalTokens: number;
  }>;
};

function formatAvailabilityPercent(value: number | null | undefined): string {
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    !Number.isFinite(value)
  )
    return "—";
  return `${Math.round(value)}%`;
}

function getAvailabilityColor(value: number | null | undefined): string {
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    !Number.isFinite(value)
  ) {
    return "var(--color-border-light)";
  }
  const clamped = Math.max(0, Math.min(100, value));
  const low = { r: 229, g: 80, b: 69 }; // 鲜亮红
  const mid = { r: 217, g: 161, b: 37 }; // 鲜亮黄
  const high = { r: 82, g: 196, b: 26 }; // 鲜亮绿

  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

  let r: number;
  let g: number;
  let b: number;

  if (clamped <= 50) {
    const t = clamped / 50;
    r = lerp(low.r, mid.r, t);
    g = lerp(low.g, mid.g, t);
    b = lerp(low.b, mid.b, t);
  } else {
    const t = (clamped - 50) / 50;
    r = lerp(mid.r, high.r, t);
    g = lerp(mid.g, high.g, t);
    b = lerp(mid.b, high.b, t);
  }

  return `rgb(${r}, ${g}, ${b})`;
}

function padDateTimeSegment(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateTimeRouteValue(value: Date): string {
  return `${value.getFullYear()}-${padDateTimeSegment(value.getMonth() + 1)}-${padDateTimeSegment(value.getDate())}T${padDateTimeSegment(value.getHours())}:${padDateTimeSegment(value.getMinutes())}`;
}

function buildSiteLogsRoute(
  siteId: number,
  range?: { from: Date; to: Date },
): string {
  const params = new URLSearchParams();
  params.set("siteId", String(siteId));
  if (range) {
    params.set("from", formatDateTimeRouteValue(range.from));
    params.set("to", formatDateTimeRouteValue(range.to));
  }
  return `/logs?${params.toString()}`;
}

function buildSiteLast24hLogsRoute(siteId: number): string {
  const now = new Date();
  const from = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours() - 23,
    0,
    0,
    0,
  );
  const to = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours() + 1,
    0,
    0,
    0,
  );
  return buildSiteLogsRoute(siteId, { from, to });
}

function parseAvailabilityBucketStart(startUtc?: string | null): Date | null {
  const text = (startUtc || "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseAvailabilityBucketLabel(label: string): Date | null {
  const match = label.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0"] = match;
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    0,
  );
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatAvailabilityBucketLabel(bucket: SiteAvailabilityBucket): string {
  const parsed =
    parseAvailabilityBucketStart(bucket.startUtc) ||
    parseAvailabilityBucketLabel(bucket.label);
  if (!parsed) return bucket.label;
  return `${parsed.getFullYear()}-${padDateTimeSegment(parsed.getMonth() + 1)}-${padDateTimeSegment(parsed.getDate())} ${padDateTimeSegment(parsed.getHours())}:${padDateTimeSegment(parsed.getMinutes())}:${padDateTimeSegment(parsed.getSeconds())}`;
}

function buildAvailabilityBucketLogsRoute(
  siteId: number,
  bucket: SiteAvailabilityBucket,
): string {
  const start =
    parseAvailabilityBucketStart(bucket.startUtc) ||
    parseAvailabilityBucketLabel(bucket.label);
  if (!start) return buildSiteLast24hLogsRoute(siteId);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return buildSiteLogsRoute(siteId, { from: start, to: end });
}

export default function Dashboard({
  adminName = "\u7ba1\u7406\u5458",
}: {
  adminName?: string;
}) {
  const isMobile = useIsMobile();
  const [data, setData] = useState<any>(null);
  const [insightsData, setInsightsData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [insightsLoading, setInsightsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [siteDistribution, setSiteDistribution] = useState<any[]>([]);
  const [siteTrend, setSiteTrend] = useState<any[]>([]);
  const [siteLoading, setSiteLoading] = useState(true);
  const [sites, setSites] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[] | null>(null);
  const [runtimeMetrics, setRuntimeMetrics] =
    useState<DashboardWindowMetrics | null>(null);
  const [runtimeMetricsLoading, setRuntimeMetricsLoading] = useState(false);
  const [siteSpeedStates, setSiteSpeedStates] = useState<
    Record<string, SiteSpeedState>
  >({});
  const [trendDays, setTrendDays] = useState(7);
  const [liveWindow, setLiveWindow] = useState(1);
  const [siteFilter, setSiteFilter] = useState("all");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [showInactiveSites, setShowInactiveSites] = useState(false);
  const toast = useToast();
  const normalizedAdminName = (adminName || "").trim() || "\u7ba1\u7406\u5458";

  const getSiteSpeedKey = (site: any, idx: number) => String(site?.id ?? idx);

  const setSiteSpeedState = (siteKey: string, nextState: SiteSpeedState) => {
    setSiteSpeedStates((current) => ({ ...current, [siteKey]: nextState }));
  };

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      else setRefreshing(true);
      setError(null);

      try {
        const result = await api.getDashboardSnapshot(
          silent ? { refresh: true } : undefined,
        );
        setData(result);
      } catch (err: any) {
        const message = err?.message || "加载仪表盘失败";
        setError(message);
        if (silent) toast.error(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [toast],
  );

  const loadInsights = useCallback(async (forceRefresh = false) => {
    setInsightsLoading(true);
    try {
      const result = await api.getDashboardInsights(
        forceRefresh ? { refresh: true } : undefined,
      );
      setInsightsData(result);
    } catch (err) {
      console.error("Failed to load dashboard insights:", err);
    } finally {
      setInsightsLoading(false);
    }
  }, []);

  const loadSiteStats = useCallback(
    async (forceRefresh = false) => {
      setSiteLoading(true);
      try {
        const [snapshot, accountsSnapshot] = await Promise.all([
          api.getSiteSnapshot(
            trendDays,
            forceRefresh ? { refresh: true } : undefined,
          ),
          api.getAccountsSnapshot(forceRefresh ? { refresh: true } : undefined),
        ]);
        setSiteDistribution(snapshot.distribution || []);
        setSiteTrend(snapshot.trend || []);
        const siteRows = Array.isArray(snapshot.sites) ? snapshot.sites : [];
        setSites(siteRows.filter((site: any) => site?.status !== "disabled"));
        setAccounts(
          Array.isArray(accountsSnapshot?.accounts)
            ? accountsSnapshot.accounts
            : [],
        );
        setSiteSpeedStates({});
      } catch (err) {
        console.error("Failed to load site stats:", err);
      } finally {
        setSiteLoading(false);
      }
    },
    [trendDays],
  );

  const loadRuntimeMetrics = useCallback(
    async (forceRefresh = false) => {
      setRuntimeMetricsLoading(true);
      try {
        const selectedSiteIds = sites
          .filter(
            (site) =>
              (siteFilter === "all" || String(site.id) === siteFilter) &&
              (platformFilter === "all" || site.platform === platformFilter),
          )
          .map((site) => Number(site.id))
          .filter((siteId) => Number.isFinite(siteId) && siteId > 0);
        const result = await api.getDashboardWindowMetrics({
          siteIds: selectedSiteIds,
          windowMinutes: liveWindow,
        });
        setRuntimeMetrics(result);
      } catch (err: any) {
        setRuntimeMetrics(null);
        if (forceRefresh) {
          toast.error(err?.message || "加载实时指标失败");
        }
      } finally {
        setRuntimeMetricsLoading(false);
      }
    },
    [liveWindow, platformFilter, siteFilter, sites, toast],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    void loadInsights();
  }, [loadInsights]);

  useEffect(() => {
    loadSiteStats();
  }, [loadSiteStats]);

  useEffect(() => {
    if (sites.length === 0) {
      setRuntimeMetrics(null);
      return;
    }
    void loadRuntimeMetrics();
  }, [liveWindow, loadRuntimeMetrics, sites.length]);

  useEffect(() => {
    if (sites.length === 0) return undefined;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void loadRuntimeMetrics();
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [liveWindow, loadRuntimeMetrics, sites.length]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const pollDashboard = async () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      )
        return;
      try {
        const next = await api.getDashboardSnapshot();
        if (!disposed) setData(next);
      } catch {
        // ignore polling errors
      }
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        void pollDashboard();
      }, 30000);
    };

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const handleVisibilityChange = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        void pollDashboard();
        start();
      } else {
        stop();
      }
    };

    handleVisibilityChange();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      disposed = true;
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
      }
    };
  }, []);

  if (loading && !data) {
    return (
      <div className="animate-fade-in">
        <div
          className="skeleton"
          style={{
            width: 280,
            height: 32,
            marginBottom: 24,
            borderRadius: "var(--radius-sm)",
          }}
        />
        <div className="dashboard-stat-grid">
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className={`stat-card animate-slide-up stagger-${i + 1}`}
            >
              <div
                className="skeleton"
                style={{ width: 80, height: 14, marginBottom: 16 }}
              />
              <div
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    className="skeleton"
                    style={{ width: 36, height: 36, borderRadius: "50%" }}
                  />
                  <div>
                    <div
                      className="skeleton"
                      style={{ width: 60, height: 10, marginBottom: 6 }}
                    />
                    <div
                      className="skeleton"
                      style={{ width: 80, height: 20 }}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    className="skeleton"
                    style={{ width: 36, height: 36, borderRadius: "50%" }}
                  />
                  <div>
                    <div
                      className="skeleton"
                      style={{ width: 60, height: 10, marginBottom: 6 }}
                    />
                    <div
                      className="skeleton"
                      style={{ width: 80, height: 20 }}
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="animate-fade-in">
        <h2 className="greeting" style={{ marginBottom: 24 }}>
          {getGreeting() + "\uFF0C" + normalizedAdminName}
        </h2>
        <div className="card" style={{ padding: 48, textAlign: "center" }}>
          <div
            style={{
              width: 48,
              height: 48,
              background: "var(--color-danger-soft)",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 12px",
            }}
          >
            <svg
              width="24"
              height="24"
              fill="none"
              viewBox="0 0 24 24"
              stroke="var(--color-danger)"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
          </div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>加载失败</div>
          <div
            style={{
              fontSize: 13,
              color: "var(--color-text-muted)",
              marginBottom: 16,
            }}
          >
            {error}
          </div>
          <button onClick={() => load()} className="btn btn-soft-primary">
            重试
          </button>
        </div>
      </div>
    );
  }

  const totalBalance = safeNumber(data?.totalBalance);
  const totalUsed = safeNumber(data?.totalUsed || 0);
  const todaySpend = safeNumber(data?.todaySpend || 0);
  const activeAccounts = safeNumber(data?.activeAccounts);
  const totalAccounts = safeNumber(data?.totalAccounts);
  const proxy24hSuccess = safeNumber(data?.proxy24h?.success);
  const proxy24hFailed = safeNumber(data?.proxy24h?.failed);
  const proxy24hBusinessLimit = safeNumber(data?.proxy24h?.businessLimit);
  const proxy24hTotal = safeNumber(data?.proxy24h?.total);
  const totalTokens = safeNumber(data?.proxy24h?.totalTokens);
  const performanceWindowSeconds = Math.max(
    1,
    safeNumber(data?.performance?.windowSeconds) || 60,
  );
  const requestsPerMinute = safeNumber(data?.performance?.requestsPerMinute);
  const tokensPerMinute = safeNumber(data?.performance?.tokensPerMinute);
  const rawSiteAvailability: SiteAvailabilitySummary[] = Array.isArray(
    insightsData?.siteAvailability,
  )
    ? insightsData.siteAvailability
    : [];
  const activeSites = rawSiteAvailability
    .filter((s) => s.totalRequests > 0)
    .sort((a, b) => (b.totalRequests || 0) - (a.totalRequests || 0));
  const inactiveSites = rawSiteAvailability.filter(
    (s) => !s.totalRequests || s.totalRequests === 0,
  );
  const siteAvailability = showInactiveSites
    ? [...activeSites, ...inactiveSites]
    : activeSites;
  const visibleSiteAvailability = siteAvailability.filter(
    (site) =>
      (siteFilter === "all" || String(site.siteId) === siteFilter) &&
      (platformFilter === "all" || site.platform === platformFilter),
  );

  const selectedSites = sites.filter(
    (site) =>
      (siteFilter === "all" || String(site.id) === siteFilter) &&
      (platformFilter === "all" || site.platform === platformFilter),
  );
  const scopedAccounts = accounts == null || sites.length === 0 ? null : accounts.filter(
    (account) =>
      selectedSites.some((site) => site.id === account.siteId) &&
      account.site?.status !== "disabled",
  );
  const scopedActiveAccounts =
    scopedAccounts == null
      ? activeAccounts
      : scopedAccounts.filter((account) => account.status === "active").length;
  const scopedTotalAccounts = scopedAccounts == null ? totalAccounts : scopedAccounts.length;
  const liveRequestTotal = runtimeMetrics?.totalCount ?? 0;
  const liveTokens = runtimeMetrics?.totalTokensAll ?? 0;
  const liveWindowMinutes = runtimeMetrics?.windowMinutes ?? liveWindow;
  const liveQps = runtimeMetrics
    ? liveRequestTotal / (liveWindowMinutes * 60)
    : requestsPerMinute / 60;
  const liveTps = runtimeMetrics
    ? liveTokens / (liveWindowMinutes * 60)
    : tokensPerMinute / 60;
  const livePeakQps = runtimeMetrics?.peakQps ?? 0;
  const liveChartBuckets = runtimeMetrics?.buckets || [];
  const liveChartMaxQps = Math.max(
    livePeakQps,
    ...liveChartBuckets.map((bucket) =>
      bucket.requestCount / Math.max(1, (liveWindowMinutes * 60) / 20),
    ),
    0.1,
  );
  const historyRequestTotal = proxy24hTotal;
  const historySuccessCount = proxy24hSuccess;
  const historyFailedCount = proxy24hFailed;
  const historyBusinessLimit = proxy24hBusinessLimit;
  const historyTokens = totalTokens;
  const proxySuccessRate =
    historyRequestTotal > 0
      ? (historySuccessCount / historyRequestTotal) * 100
      : null;
  const proxyErrorRate =
    proxySuccessRate == null ? null : 100 - proxySuccessRate;
  const slaRequestTotal = Math.max(0, historyRequestTotal - historyBusinessLimit);
  const slaFailedCount = Math.max(0, historyFailedCount - historyBusinessLimit);
  const slaSuccessRate =
    slaRequestTotal > 0
      ? ((slaRequestTotal - slaFailedCount) / slaRequestTotal) * 100
      : null;
  const upstreamFailedCount = Math.max(0, historyFailedCount - historyBusinessLimit);
  const upstreamErrorRate =
    slaRequestTotal > 0 ? (upstreamFailedCount / slaRequestTotal) * 100 : null;
  const averageQps = liveQps;
  const averageTps = liveTps;
  const healthPercent =
    scopedTotalAccounts > 0
      ? Math.round((scopedActiveAccounts / scopedTotalAccounts) * 100)
      : 0;
  const healthLabel =
    scopedTotalAccounts === 0
      ? "待机"
      : scopedActiveAccounts === scopedTotalAccounts
        ? "正常"
        : scopedActiveAccounts > 0
          ? "降级"
          : "离线";
  const modelRanking = Array.isArray(insightsData?.modelAnalysis?.callRanking)
    ? insightsData.modelAnalysis.callRanking
    : [];
  const weightedLatency = modelRanking.reduce(
    (sum: number, item: any) =>
      sum + safeNumber(item.avgLatencyMs) * safeNumber(item.calls),
    0,
  );
  const rankedCalls = modelRanking.reduce(
    (sum: number, item: any) => sum + safeNumber(item.calls),
    0,
  );
  const modelAverageLatencyMs =
    rankedCalls > 0 ? Math.round(weightedLatency / rankedCalls) : null;
  const averageLatencyMs = modelAverageLatencyMs;
  const ttftMs = runtimeMetrics?.averageFirstByteLatencyMs ?? null;
  const refreshLabel = data?.generatedAt
    ? new Date(data.generatedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
  const metricsScopeLabel = "最近 24h";

  const getLatencyColor = (ms: number) =>
    ms <= 500
      ? "var(--color-success)"
      : ms <= 1000
        ? "color-mix(in srgb, var(--color-success) 60%, var(--color-warning))"
        : ms <= 1500
          ? "var(--color-warning)"
          : ms <= 2000
            ? "color-mix(in srgb, var(--color-warning) 60%, var(--color-danger))"
            : ms < 3000
              ? "color-mix(in srgb, var(--color-warning) 30%, var(--color-danger))"
              : "var(--color-danger)";

  const renderSiteSpeedLabel = (site: any, idx: number) => {
    const siteKey = getSiteSpeedKey(site, idx);
    const speedState = siteSpeedStates[siteKey];

    if (!speedState || speedState.status === "loading") {
      return speedState ? "..." : "测速";
    }

    if (speedState.status === "timeout") {
      return "超时";
    }

    const ms = speedState.ms;
    const color = getLatencyColor(ms);

    return (
      <>
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
            boxShadow: `0 0 4px ${color}`,
            animation: "pulse 1.5s ease-in-out infinite",
            marginRight: 3,
            verticalAlign: "middle",
          }}
        />
        <span style={{ color, fontWeight: 600 }}>{ms}ms</span>
      </>
    );
  };

  return (
    <div className="ops-dashboard animate-fade-in">
      <header className="ops-dashboard-header">
        <div>
          <div className="ops-dashboard-title-row">
            <span className="ops-dashboard-title-icon" aria-hidden="true">
              <svg
                width="20"
                height="20"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.8}
                  d="M4 13h4l2-8 4 14 2-6h4"
                />
              </svg>
            </span>
            <h1 className="ops-dashboard-title">运维监控</h1>
          </div>
          <div className="ops-dashboard-status">
            <span
              className={
                "ops-status-dot " +
                (healthLabel === "离线"
                  ? "is-danger"
                  : healthLabel === "降级"
                    ? "is-warning"
                    : "")
              }
            />
            <span>{healthLabel}</span>
            <span className="ops-status-divider">·</span>
            <span>刷新：{refreshLabel}</span>
          </div>
        </div>
        <div className="ops-dashboard-toolbar">
          <select
            className="ops-select"
            aria-label="站点筛选"
            value={siteFilter}
            onChange={(event) => setSiteFilter(event.target.value)}
          >
            <option value="all">全部站点</option>
            {rawSiteAvailability.map((site) => (
              <option key={site.siteId} value={site.siteId}>
                {site.siteName}
              </option>
            ))}
          </select>
          <select
            className="ops-select"
            aria-label="平台筛选"
            value={platformFilter}
            onChange={(event) => setPlatformFilter(event.target.value)}
          >
            <option value="all">全部平台</option>
            {[
              ...new Set(
                rawSiteAvailability
                  .map((site) => site.platform)
                  .filter(Boolean),
              ),
            ].map((platform) => (
              <option key={platform} value={platform || ""}>
                {platform}
              </option>
            ))}
          </select>
          <select
            className="ops-select ops-select-wide"
            aria-label="时间范围"
            value={trendDays}
            onChange={(event) => setTrendDays(Number(event.target.value))}
          >
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
            <option value={90}>近 90 天</option>
          </select>
          <button
            className="ops-toolbar-icon"
            onClick={() => {
              void load(true);
              void loadInsights(true);
              void loadSiteStats(true);
              if (sites.length > 0) {
                void loadRuntimeMetrics(true);
              }
            }}
            disabled={refreshing}
            aria-label="刷新数据"
            title="刷新数据"
          >
            <svg
              width="17"
              height="17"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              style={{
                animation: refreshing ? "spin 1s linear infinite" : "none",
              }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                d="M4 4v5h.6m15.3 2A8 8 0 0 0 4.6 9M4.6 9H9m11 11v-5h-.6m0 0a8 8 0 0 1-15.3-2m15.3 2H15"
              />
            </svg>
          </button>
          <Link
            className="ops-toolbar-button ops-toolbar-button-primary"
            to="/settings/notify"
          >
            预警规则
          </Link>
          <Link className="ops-toolbar-button" to="/settings">
            设置
          </Link>
        </div>
      </header>

      <section
        className="ops-overview-grid"
        aria-label="运行概览"
        aria-busy={runtimeMetricsLoading}
      >
        <article className="ops-live-card">
          <div className="ops-health-block">
            <svg
              className="ops-health-ring"
              viewBox="0 0 120 120"
              role="img"
              aria-label={"系统健康度 " + healthPercent + "%"}
            >
              <circle
                className="ops-health-ring-track"
                cx="60"
                cy="60"
                r="48"
              />
              <circle
                className="ops-health-ring-progress"
                cx="60"
                cy="60"
                r="48"
                pathLength="100"
                style={{ strokeDasharray: healthPercent + " 100" }}
              />
            </svg>
            <div className="ops-health-ring-copy">
              <strong>{healthLabel}</strong>
              <span>健康度</span>
            </div>
            <div className="ops-health-caption">
              健康状态 <span aria-hidden="true">ⓘ</span>
            </div>
            <div className="ops-health-state">
              {scopedActiveAccounts}/{scopedTotalAccounts} 个账户在线
            </div>
          </div>
          <div className="ops-live-content">
            <div className="ops-card-heading ops-live-heading">
              <span className="ops-heading-accent ops-heading-accent-blue" />
              <span>实时信息</span>
              <span className="ops-info-icon" title="最近窗口内的代理吞吐">
                ⓘ
              </span>
              <div
                className="ops-segmented-control"
                role="group"
                aria-label="实时窗口"
              >
                {[1, 5, 30, 60].map((minutes) => (
                  <button
                    key={minutes}
                    className={liveWindow === minutes ? "active" : ""}
                    onClick={() => setLiveWindow(minutes)}
                  >
                    {minutes < 60 ? minutes + "min" : "1h"}
                  </button>
                ))}
              </div>
            </div>
            <div className="ops-live-kpis">
              <div>
                <span>当前</span>
                <strong>
                  {averageQps.toFixed(1)} <small>QPS</small>
                </strong>
              </div>
              <div>
                <span className="ops-kpi-spacer">&nbsp;</span>
                <strong>
                  {averageTps.toFixed(1)} <small>TPS</small>
                </strong>
              </div>
              <div>
                <span>峰值</span>
                <strong>
                  {livePeakQps.toFixed(1)}{" "}
                  <small>QPS</small>
                </strong>
              </div>
              <div>
                <span className="ops-kpi-spacer">&nbsp;</span>
                <strong>
                  {formatCompactTokenMetric(liveTokens)} <small>Tokens</small>
                </strong>
              </div>
            </div>
            <div className="ops-live-chart" aria-hidden="true">
              {liveChartBuckets.map((bucket, index) => {
                const bucketQps =
                  bucket.requestCount /
                  Math.max(1, (liveWindowMinutes * 60) / 20);
                const height = bucket.requestCount
                  ? Math.max(8, (bucketQps / liveChartMaxQps) * 100)
                  : 4;
                return (
                  <span
                    key={index}
                    title={`${bucket.requestCount} 请求 · ${bucketQps.toFixed(2)} QPS`}
                    style={{ height: height + "%" }}
                  />
                );
              })}
            </div>
            <div className="ops-live-chart-label">
              最近 {liveWindow === 60 ? "1 小时" : liveWindow + " 分钟"} · QPS /
              TPS 实时采样
            </div>
          </div>
        </article>

        <article className="ops-metric-card">
          <div className="ops-card-heading">
              <span>请求 · {metricsScopeLabel}</span>
            <span className="ops-info-icon" title="最近 24 小时请求统计">
              ⓘ
            </span>
            <Link to="/logs">明细</Link>
          </div>
          <div className="ops-metric-line">
            <span>请求数</span>
            <strong>{Math.round(historyRequestTotal).toLocaleString()}</strong>
          </div>
          <div className="ops-metric-line">
            <span>Token 数</span>
            <strong>{formatCompactTokenMetric(historyTokens)}</strong>
          </div>
          <div className="ops-metric-subgrid">
            <span>
              当前 QPS <b>{averageQps.toFixed(1)}</b>
            </span>
            <span>
              当前 TPS <b>{averageTps.toFixed(1)}</b>
            </span>
          </div>
        </article>

        <article className="ops-metric-card">
          <div className="ops-card-heading">
            <span>SLA（排除业务限制）</span>
            <span className="ops-info-icon">ⓘ</span>
            <Link to="/logs">明细</Link>
          </div>
          <div
            className="ops-sla-value"
            style={{
              color:
                slaSuccessRate == null
                  ? "var(--ops-muted)"
                  : "var(--ops-green)",
            }}
          >
            {slaSuccessRate == null ? "—" : slaSuccessRate.toFixed(2) + "%"}
          </div>
          <div className="ops-progress-track">
            <span
              style={{
                width: Math.max(0, Math.min(100, slaSuccessRate ?? 0)) + "%",
              }}
            />
          </div>
          <div className="ops-metric-footer">
            <span>异常数</span>
            <strong>{Math.round(slaFailedCount).toLocaleString()}</strong>
          </div>
        </article>

        <article className="ops-metric-card">
          <div className="ops-card-heading">
            <span>请求错误</span>
            <span className="ops-info-icon">ⓘ</span>
            <Link to="/logs">明细</Link>
          </div>
          <div
            className="ops-big-percent"
            style={{
              color:
                proxyErrorRate == null
                  ? "var(--ops-muted)"
                  : proxyErrorRate > 0
                    ? "var(--ops-red)"
                    : "var(--ops-green)",
            }}
          >
            {proxyErrorRate == null ? "—" : proxyErrorRate.toFixed(2) + "%"}
          </div>
          <div className="ops-metric-footer">
            <span>错误数</span>
            <strong>{Math.round(historyFailedCount).toLocaleString()}</strong>
          </div>
          <div className="ops-metric-footer">
            <span>业务限制</span>
            <strong>{Math.round(historyBusinessLimit).toLocaleString()}</strong>
          </div>
        </article>

        <article className="ops-metric-card">
          <div className="ops-card-heading">
            <span>请求时长</span>
            <span className="ops-info-icon">ⓘ</span>
            <Link to="/logs">明细</Link>
          </div>
          <div className="ops-latency-value">
            {averageLatencyMs == null ? "—" : averageLatencyMs}{" "}
            <small>ms (平均)</small>
          </div>
          <div className="ops-latency-grid">
            <span>
              P95: <b>—</b>
            </span>
            <span>
              P90: <b>—</b>
            </span>
            <span>
              P50: <b>—</b>
            </span>
            <span>
              Avg.:{" "}
              <b>{averageLatencyMs == null ? "—" : averageLatencyMs + "ms"}</b>
            </span>
            <span>
              Max.: <b>—</b>
            </span>
          </div>
        </article>

        <article className="ops-metric-card">
          <div className="ops-card-heading">
            <span>TTFT</span>
            <span className="ops-info-icon">ⓘ</span>
            <Link to="/logs">明细</Link>
          </div>
          <div className="ops-latency-value">
            {ttftMs == null ? "—" : ttftMs} <small>ms (平均)</small>
          </div>
          <div className="ops-latency-grid">
            <span>
              P95: <b>—</b>
            </span>
            <span>
              P90: <b>—</b>
            </span>
            <span>
              P50: <b>—</b>
            </span>
            <span>
              Avg.: <b>{ttftMs == null ? "—" : ttftMs + "ms"}</b>
            </span>
            <span>
              Max.: <b>—</b>
            </span>
          </div>
        </article>

        <article className="ops-metric-card">
          <div className="ops-card-heading">
            <span>上游错误</span>
            <span className="ops-info-icon">ⓘ</span>
            <Link to="/logs">明细</Link>
          </div>
          <div
            className="ops-big-percent"
            style={{
              color: upstreamFailedCount > 0 ? "var(--ops-red)" : "var(--ops-green)",
            }}
          >
            {upstreamErrorRate == null
              ? "—"
              : upstreamErrorRate.toFixed(2) + "%"}
          </div>
          <div className="ops-metric-footer">
            <span>错误数（排除 429/529）</span>
            <strong>{Math.round(upstreamFailedCount).toLocaleString()}</strong>
          </div>
          <div className="ops-metric-footer">
            <span>429/529</span>
            <strong>{Math.round(historyBusinessLimit).toLocaleString()}</strong>
          </div>
        </article>
      </section>

      <section className="ops-resource-strip" aria-label="系统资源状态">
        <div>
          <span className="ops-resource-label">
            账户 <span className="ops-info-icon">ⓘ</span>
          </span>
          <strong>
            {scopedActiveAccounts}/{scopedTotalAccounts}
          </strong>
          <small>活跃账户 / 总账户</small>
        </div>
        <div>
          <span className="ops-resource-label">
            站点 <span className="ops-info-icon">ⓘ</span>
          </span>
          <strong>{rawSiteAvailability.length}</strong>
          <small>{activeSites.length} 个有流量</small>
        </div>
        <div>
          <span className="ops-resource-label">
            24h 请求 <span className="ops-info-icon">ⓘ</span>
          </span>
            <strong>{Math.round(historyRequestTotal).toLocaleString()}</strong>
            <small>{Math.round(historySuccessCount).toLocaleString()} 次成功</small>
        </div>
        <div>
          <span className="ops-resource-label">
            24h Tokens <span className="ops-info-icon">ⓘ</span>
          </span>
          <strong>{formatCompactTokenMetric(historyTokens)}</strong>
          <small>累计处理量</small>
        </div>
        <div>
          <span className="ops-resource-label">
            路由 <span className="ops-info-icon">ⓘ</span>
          </span>
          <strong className={sites.length ? "is-good" : "is-muted"}>
            {sites.length ? "正常" : "待配置"}
          </strong>
          <small>{sites.length} 个代理端点</small>
        </div>
        <div>
          <span className="ops-resource-label">
            采样窗口 <span className="ops-info-icon">ⓘ</span>
          </span>
          <strong>正常</strong>
          <small>最近 {performanceWindowSeconds} 秒实时指标</small>
        </div>
      </section>

      <section className="ops-section">
        <div className="ops-section-heading">
          <div>
            <h2>业务分析</h2>
            <p>围绕站点、模型和请求趋势查看运行情况</p>
          </div>
          <div className="ops-days-control">
            {[7, 30, 90].map((days) => (
              <button
                key={days}
                className={trendDays === days ? "active" : ""}
                onClick={() => setTrendDays(days)}
              >
                {days}天
              </button>
            ))}
          </div>
        </div>
        <div className="ops-chart-grid">
          <Suspense fallback={<ChartFallback height={320} />}>
            <SiteDistributionChart
              data={siteDistribution}
              loading={siteLoading}
            />
          </Suspense>
          <Suspense fallback={<ChartFallback height={320} />}>
            <SiteTrendChart data={siteTrend} loading={siteLoading} />
          </Suspense>
        </div>
      </section>

      <section className="ops-lower-grid">
        <div className="chart-container ops-panel">
          <div className="ops-panel-heading">
            <div>
              <h2>站点可用性观测</h2>
              <p>最近 24 小时 · 每色块 = 1h · 按使用量排序</p>
            </div>
            <div className="site-observability-legend">
              <span>低</span>
              <i style={{ background: getAvailabilityColor(0) }} />
              <i style={{ background: getAvailabilityColor(50) }} />
              <i style={{ background: getAvailabilityColor(100) }} />
              <span>高</span>
            </div>
          </div>
          {visibleSiteAvailability.length > 0 ? (
            <div className="site-observability-grid">
              {visibleSiteAvailability.slice(0, 6).map((site) => (
                <div
                  key={site.siteId}
                  className={
                    "site-observability-card" +
                    (site.totalRequests > 0
                      ? ""
                      : " site-observability-card--inactive")
                  }
                >
                  <div className="site-observability-card-top">
                    <div className="site-observability-card-title">
                      <span className="site-observability-site-name">
                        {site.siteName}
                      </span>
                      {site.platform && (
                        <span className="site-observability-platform-badge">
                          {site.platform}
                        </span>
                      )}
                    </div>
                    <Link
                      to={buildSiteLast24hLogsRoute(site.siteId)}
                      className="site-observability-log-link-compact"
                      aria-label={"查看 " + site.siteName + " 日志"}
                    >
                      →
                    </Link>
                  </div>
                  <div className="site-observability-card-metrics">
                    <strong
                      style={{
                        color: getAvailabilityColor(site.availabilityPercent),
                      }}
                    >
                      {formatAvailabilityPercent(site.availabilityPercent)}
                    </strong>
                    <span>·</span>
                    <span>
                      {site.averageLatencyMs != null
                        ? site.averageLatencyMs + "ms"
                        : "—"}
                    </span>
                    <span>·</span>
                    <span>{Math.round(site.totalRequests || 0)} 次</span>
                  </div>
                  <div className="site-availability-strip-compact">
                    {site.buckets.map((bucket, index) => (
                      <Link
                        key={site.siteId + "-" + index}
                        to={buildAvailabilityBucketLogsRoute(
                          site.siteId,
                          bucket,
                        )}
                        className="site-availability-cell site-availability-cell-link site-availability-cell-pill"
                        style={{
                          background: getAvailabilityColor(
                            bucket.availabilityPercent,
                          ),
                          opacity: bucket.totalRequests > 0 ? 1 : 0.3,
                        }}
                        aria-label={
                          site.siteName +
                          " " +
                          formatAvailabilityBucketLabel(bucket) +
                          " 使用日志"
                        }
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="ops-empty-state">
              <strong>暂无站点观测数据</strong>
              <span>有代理请求后，这里会自动生成可用性和响应速度。</span>
            </div>
          )}
        </div>
        <div className="chart-container ops-panel ops-model-panel">
          <div className="ops-panel-heading">
            <div>
              <h2>模型数据分析</h2>
              <p>近 7 天调用与消耗概览</p>
            </div>
            <Link className="ops-inline-link" to="/models">
              查看模型
            </Link>
          </div>
          {insightsLoading && !insightsData ? (
            <ChartFallback height={240} />
          ) : (
            <Suspense fallback={<ChartFallback height={240} />}>
              <ModelAnalysisPanel data={insightsData?.modelAnalysis} />
            </Suspense>
          )}
        </div>
      </section>

      <section className="ops-panel ops-sites-panel">
        <div className="ops-panel-heading">
          <div>
            <h2>代理端点</h2>
            <p>快速检查当前站点连接状态</p>
          </div>
          {sites.length > 0 && (
            <button
              className="ops-inline-link ops-inline-button"
              onClick={async () => {
                await Promise.all(
                  sites.map(async (site: any, idx: number) => {
                    const siteKey = getSiteSpeedKey(site, idx);
                    setSiteSpeedState(siteKey, { status: "loading" });
                    try {
                      const begin = performance.now();
                      await fetch(site.url + "/v1/models", {
                        method: "GET",
                        mode: "no-cors",
                      });
                      setSiteSpeedState(siteKey, {
                        status: "done",
                        ms: Math.round(performance.now() - begin),
                      });
                    } catch {
                      setSiteSpeedState(siteKey, { status: "timeout" });
                    }
                  }),
                );
                toast.success("全部测速完成");
              }}
            >
              一键测速
            </button>
          )}
        </div>
        {sites.length > 0 ? (
          <div className="ops-site-list">
            {sites.map((site: any, idx: number) => (
              <div key={site.id || idx} className="ops-site-row">
                <div>
                  <strong>{site.name}</strong>
                  <span>{site.platform || "代理站点"}</span>
                  <a href={site.url} target="_blank" rel="noopener noreferrer">
                    {site.url}
                  </a>
                </div>
                <div className="ops-site-actions">
                  <button
                    className="ops-speed-button"
                    onClick={async () => {
                      const siteKey = getSiteSpeedKey(site, idx);
                      setSiteSpeedState(siteKey, { status: "loading" });
                      try {
                        const begin = performance.now();
                        await fetch(site.url + "/v1/models", {
                          method: "GET",
                          mode: "no-cors",
                        });
                        const ms = Math.round(performance.now() - begin);
                        setSiteSpeedState(siteKey, { status: "done", ms });
                        toast.success(site.name + ": " + ms + "ms");
                      } catch {
                        setSiteSpeedState(siteKey, { status: "timeout" });
                        toast.error(site.name + ": 测速失败");
                      }
                    }}
                  >
                    {renderSiteSpeedLabel(site, idx)}
                  </button>
                  <a
                    className="ops-site-open"
                    href={site.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    打开 ↗
                  </a>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="ops-empty-state">
            <strong>还没有代理端点</strong>
            <span>添加站点后，可以在这里进行连接检查。</span>
            <Link
              className="ops-toolbar-button ops-toolbar-button-primary"
              to="/sites"
            >
              添加站点
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
