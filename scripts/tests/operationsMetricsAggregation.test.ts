import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateOperationsCounts,
  calculateMetricDistribution,
  countAttemptFailures,
  countRateLimitedAttempts,
  countServerErrorAttempts,
  type OperationsAttemptMetricRow,
  type OperationsOutcomeMetricRow,
} from '../../src/server/services/operationsMetricsAggregation.js';

function outcome(overrides: Partial<OperationsOutcomeMetricRow> = {}): OperationsOutcomeMetricRow {
  return {
    requestId: 'request',
    startedAt: '2026-09-20T00:00:00.000Z',
    completedAt: '2026-09-20T00:00:01.000Z',
    modelRequested: 'model',
    siteId: 1,
    status: 'success',
    httpStatus: 200,
    latencyMs: 100,
    firstByteLatencyMs: null,
    attemptCount: 1,
    failedAttemptCount: 0,
    totalTokens: 10,
    estimatedCost: 0.1,
    errorClass: null,
    ...overrides,
  };
}

test('empty metric samples stay null instead of becoming zero', () => {
  assert.deepEqual(calculateMetricDistribution([]), {
    count: 0,
    average: null,
    p50: null,
    p90: null,
    p95: null,
    max: null,
  });
  assert.equal(aggregateOperationsCounts([]).successRate, null);
});

test('retry requests and recovered requests are counted from final outcomes', () => {
  const counts = aggregateOperationsCounts([
    outcome({ requestId: 'recovered', attemptCount: 2, failedAttemptCount: 1 }),
    outcome({ requestId: 'failed-retry', status: 'failed', attemptCount: 3, failedAttemptCount: 3 }),
    outcome({ requestId: 'single-failure', status: 'failed', attemptCount: 1, failedAttemptCount: 1 }),
  ]);
  assert.equal(counts.total, 3);
  assert.equal(counts.retryRequests, 2);
  assert.equal(counts.recoveredRequests, 1);
  assert.ok(Math.abs((counts.successRate || 0) - (100 / 3)) < 1e-12);
});

test('429 is rate limited while 529 remains a server error', () => {
  const attempts: OperationsAttemptMetricRow[] = [
    { occurredAt: '2026-09-20T00:00:00.000Z', siteId: 1, status: 'failed', httpStatus: 529, latencyMs: 10, firstByteLatencyMs: null, totalTokens: null, estimatedCost: null },
    { occurredAt: '2026-09-20T00:00:00.000Z', siteId: 1, status: 'failed', httpStatus: 429, latencyMs: 10, firstByteLatencyMs: null, totalTokens: null, estimatedCost: null },
  ];
  assert.equal(aggregateOperationsCounts([outcome({ status: 'failed', httpStatus: 529 })]).failed, 1);
  assert.equal(countAttemptFailures(attempts), 2);
  assert.equal(countRateLimitedAttempts(attempts), 1);
  assert.equal(countServerErrorAttempts(attempts), 1);
});

test('percentiles use valid samples and preserve low-sample distribution semantics', () => {
  const distribution = calculateMetricDistribution([100, null, 20, -1, 40]);
  assert.equal(distribution.count, 3);
  assert.equal(distribution.average, 160 / 3);
  assert.equal(distribution.p50, 40);
  assert.equal(distribution.p90, 100);
  assert.equal(distribution.p95, 100);
  assert.equal(distribution.max, 100);
  assert.equal(calculateMetricDistribution([7]).p95, 7);
});
