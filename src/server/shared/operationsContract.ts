export type OperationsWindow = 60 | 1440 | 10080;

export interface MetricDistribution {
  count: number;
  average: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
}

export interface OperationsCounts {
  total: number;
  success: number;
  failed: number;
  cancelled: number;
  rejected: number;
  unknown: number;
  successRate: number | null;
  tokens: number;
  cost: number;
  retryRequests: number;
  recoveredRequests: number;
}

export interface OperationsScope {
  from: string;
  to: string;
  windowMinutes: OperationsWindow;
  siteId: number | null;
  platform: string | null;
  timezone: string;
}

export interface OperationsTimelineBucket {
  from: string;
  to: string;
  requests: number;
  failed: number;
  rejected: number;
  cancelled: number;
  attempts: number;
  tokens: number;
}

export interface OperationsSite {
  id: number;
  name: string;
  platform: string;
  status: string;
  requests: OperationsCounts;
  attempts: number;
  failedAttempts: number;
  latency: MetricDistribution;
  firstByte: MetricDistribution;
  buckets: Array<{ total: number; failed: number }>;
  accounts: number;
  activeAccounts: number;
  channels: number;
  readyChannels: number;
  coolingChannels: number;
}

export interface OperationsFocus {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  evidence: string;
  action: string;
  siteId: number | null;
  kind: 'request' | 'attempt' | 'route' | 'telemetry';
}

export interface OperationsSnapshot {
  generatedAt: string;
  scope: OperationsScope;
  previousScope: { from: string; to: string };
  current: OperationsCounts;
  previous: OperationsCounts;
  latency: MetricDistribution;
  firstByte: MetricDistribution;
  attempts: {
    total: number;
    failed: number;
    rateLimited: number;
    serverErrors: number;
    tokens: number;
    cost: number;
  };
  live: {
    from: string;
    to: string;
    windowMinutes: number;
    requests: number;
    tokens: number;
    qps: number;
    tokensPerSecond: number;
    peakQps: number;
    bucketSeconds: number;
    buckets: OperationsTimelineBucket[];
  };
  timeline: OperationsTimelineBucket[];
  sites: OperationsSite[];
  filters: Array<{ id: number; name: string; platform: string; status: string }>;
  errors: Array<{ kind: string; count: number }>;
  focus: OperationsFocus[];
  telemetry: {
    observedSince: string | null;
    lastObservedAt: string | null;
    historyComplete: boolean;
    latencyCoverage: number | null;
    firstByteCoverage: number | null;
    unassignedRequests: number;
    writeFailures: number;
    pendingWrites: number;
    inFlight: number;
    notes: string[];
  };
  recentFailures: Array<{
    requestId: string;
    completedAt: string;
    model: string | null;
    siteId: number | null;
    status: string;
    httpStatus: number | null;
    errorClass: string | null;
    latencyMs: number | null;
    attemptCount: number;
  }>;
}

export interface OperationsRequestRecord {
  requestId: string;
  startedAt: string;
  completedAt: string;
  downstreamPath: string;
  modelRequested: string | null;
  siteId: number | null;
  status: string;
  httpStatus: number | null;
  latencyMs: number | null;
  firstByteLatencyMs: number | null;
  attemptCount: number;
  failedAttemptCount: number;
  totalTokens: number | null;
  errorClass: string | null;
}

export interface OperationsRequestsResponse {
  items: OperationsRequestRecord[];
  total: number;
  limit: number;
  offset: number;
}
