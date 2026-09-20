import type {
  MetricDistribution,
  OperationsCounts,
  OperationsTimelineBucket,
} from '../shared/operationsContract.js';

export type OperationsOutcomeMetricRow = {
  requestId: string;
  startedAt: string;
  completedAt: string;
  modelRequested: string | null;
  siteId: number | null;
  status: string;
  httpStatus: number | null;
  latencyMs: number | null;
  firstByteLatencyMs: number | null;
  attemptCount: number;
  failedAttemptCount: number;
  totalTokens: number | null;
  estimatedCost: number | null;
  errorClass: string | null;
};

export type OperationsAttemptMetricRow = {
  occurredAt: string;
  siteId: number | null;
  status: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  firstByteLatencyMs: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
};

export type OperationsBucketInput = {
  fromMs: number;
  toMs: number;
  bucketSeconds: number;
  outcomes: OperationsOutcomeMetricRow[];
  attempts: OperationsAttemptMetricRow[];
};

export function normalizeOutcomeStatus(raw: string | null | undefined): string {
  switch ((raw || '').trim().toLowerCase()) {
    case 'success':
    case 'failed':
    case 'cancelled':
    case 'rejected':
    case 'unknown':
      return (raw || '').trim().toLowerCase();
    default:
      return 'unknown';
  }
}

function finiteNonNegative(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value >= 0 ? value : null;
}

function sumFinite(values: Array<number | null | undefined>): number {
  return values.reduce<number>((sum, value) => {
    const normalized = finiteNonNegative(value);
    return sum + (normalized ?? 0);
  }, 0);
}

export function calculatePercentile(values: number[], percentile: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(sorted.length * percentile));
  return sorted[rank - 1];
}

export function calculateMetricDistribution(
  values: Array<number | null | undefined>,
): MetricDistribution {
  const valid = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (valid.length === 0) {
    return { count: 0, average: null, p50: null, p90: null, p95: null, max: null };
  }
  const total = valid.reduce((sum, value) => sum + value, 0);
  return {
    count: valid.length,
    average: total / valid.length,
    p50: calculatePercentile(valid, 0.5),
    p90: calculatePercentile(valid, 0.9),
    p95: calculatePercentile(valid, 0.95),
    max: Math.max(...valid),
  };
}

export function aggregateOperationsCounts(
  rows: OperationsOutcomeMetricRow[],
): OperationsCounts {
  const counts = {
    total: rows.length,
    success: 0,
    failed: 0,
    cancelled: 0,
    rejected: 0,
    unknown: 0,
    successRate: null as number | null,
    tokens: sumFinite(rows.map((row) => row.totalTokens)),
    cost: sumFinite(rows.map((row) => row.estimatedCost)),
    retryRequests: 0,
    recoveredRequests: 0,
  };

  for (const row of rows) {
    const status = normalizeOutcomeStatus(row.status);
    if (status === 'success') counts.success += 1;
    else if (status === 'failed') counts.failed += 1;
    else if (status === 'cancelled') counts.cancelled += 1;
    else if (status === 'rejected') counts.rejected += 1;
    else counts.unknown += 1;

    if (row.attemptCount > 1) {
      counts.retryRequests += 1;
      if (status === 'success' && row.failedAttemptCount > 0) counts.recoveredRequests += 1;
    }
  }

  counts.successRate = counts.total > 0 ? (counts.success / counts.total) * 100 : null;
  return counts;
}

export function buildOperationsTimeline(input: OperationsBucketInput): OperationsTimelineBucket[] {
  const spanMs = Math.max(1, input.toMs - input.fromMs);
  const bucketMs = Math.max(1_000, input.bucketSeconds * 1_000);
  const bucketCount = Math.max(1, Math.ceil(spanMs / bucketMs));
  const buckets: OperationsTimelineBucket[] = Array.from({ length: bucketCount }, (_, index) => {
    const bucketFromMs = input.fromMs + index * bucketMs;
    return {
      from: new Date(bucketFromMs).toISOString(),
      to: new Date(Math.min(input.toMs, bucketFromMs + bucketMs)).toISOString(),
      requests: 0,
      failed: 0,
      rejected: 0,
      cancelled: 0,
      attempts: 0,
      tokens: 0,
    };
  });

  const bucketIndex = (timeMs: number) => {
    const index = Math.floor((timeMs - input.fromMs) / bucketMs);
    return index >= 0 && index < buckets.length ? index : -1;
  };

  for (const row of input.outcomes) {
    const timeMs = Date.parse(row.completedAt);
    const index = bucketIndex(timeMs);
    if (index < 0) continue;
    const bucket = buckets[index];
    bucket.requests += 1;
    const status = normalizeOutcomeStatus(row.status);
    if (status === 'failed') bucket.failed += 1;
    if (status === 'rejected') bucket.rejected += 1;
    if (status === 'cancelled') bucket.cancelled += 1;
    bucket.tokens += finiteNonNegative(row.totalTokens) ?? 0;
  }

  for (const row of input.attempts) {
    const timeMs = Date.parse(row.occurredAt);
    const index = bucketIndex(timeMs);
    if (index < 0) continue;
    buckets[index].attempts += 1;
  }
  return buckets;
}

export function countAttemptFailures(rows: OperationsAttemptMetricRow[]): number {
  return rows.filter((row) => (row.status || '').trim().toLowerCase() !== 'success').length;
}

export function countRateLimitedAttempts(rows: OperationsAttemptMetricRow[]): number {
  return rows.filter((row) => row.httpStatus === 429).length;
}

export function countServerErrorAttempts(rows: OperationsAttemptMetricRow[]): number {
  return rows.filter((row) => {
    const status = row.httpStatus;
    return typeof status === 'number' && status >= 500;
  }).length;
}
