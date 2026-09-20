import type { FastifyInstance } from 'fastify';
import {
  getOperationsSnapshot,
  listOperationsRequests,
  OperationsMetricsQueryLimitError,
} from '../../services/operationsMetrics.js';
import type { OperationsWindow } from '../../shared/operationsContract.js';

const WINDOWS = new Set([60, 1440, 10080]);
const LIVE_WINDOWS = new Set([1, 5, 30, 60]);
const STATUSES = new Set(['success', 'failed', 'cancelled', 'rejected', 'unknown']);

function parseAllowedInteger(raw: string | undefined, allowed: Set<number>, fallback: number): number {
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isInteger(parsed) && allowed.has(parsed) ? parsed : fallback;
}

function parseOptionalInteger(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseTimestamp(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export async function operationsRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      windowMinutes?: string;
      liveWindowMinutes?: string;
      siteId?: string;
      platform?: string;
    };
  }>('/api/stats/operations', async (request, reply) => {
    const windowMinutes = parseAllowedInteger(request.query.windowMinutes, WINDOWS, 1440) as OperationsWindow;
    const liveWindowMinutes = parseAllowedInteger(request.query.liveWindowMinutes, LIVE_WINDOWS, 5) as 1 | 5 | 30 | 60;
    const siteId = parseOptionalInteger(request.query.siteId);
    const platform = request.query.platform?.trim() || undefined;
    try {
      const snapshot = await getOperationsSnapshot({ windowMinutes, liveWindowMinutes, siteId, platform });
      reply.header('cache-control', 'no-store');
      return snapshot;
    } catch (error) {
      if (error instanceof OperationsMetricsQueryLimitError) {
        return reply.code(503).send({ success: false, message: '查询范围内数据量过大，请缩短时间窗口后重试' });
      }
      throw error;
    }
  });

  app.get<{
    Querystring: {
      requestId?: string;
      from?: string;
      to?: string;
      siteId?: string;
      platform?: string;
      status?: string;
      recovered?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/stats/operations/requests', async (request, reply) => {
    const now = Date.now();
    const defaultFrom = now - 24 * 60 * 60 * 1_000;
    const fromMs = parseTimestamp(request.query.from, defaultFrom);
    const toMs = parseTimestamp(request.query.to, now);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      return reply.code(400).send({ success: false, message: 'from/to must be valid timestamps with to > from' });
    }
    const siteId = parseOptionalInteger(request.query.siteId);
    const platform = request.query.platform?.trim() || undefined;
    const status = request.query.status?.trim().toLowerCase() || undefined;
    if (status && !STATUSES.has(status)) {
      return reply.code(400).send({ success: false, message: 'status is invalid' });
    }
    const requestId = request.query.requestId?.trim() || undefined;
    const limitRaw = Number.parseInt(request.query.limit || '', 10);
    const offsetRaw = Number.parseInt(request.query.offset || '', 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 100;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
    const recovered = request.query.recovered === 'true';
    try {
      const response = await listOperationsRequests({ fromMs, toMs, requestId, siteId, platform, status, recovered, limit, offset });
      reply.header('cache-control', 'no-store');
      return response;
    } catch (error) {
      if (error instanceof OperationsMetricsQueryLimitError) {
        return reply.code(503).send({ success: false, message: '查询范围内数据量过大，请缩短 from/to 时间范围后重试' });
      }
      throw error;
    }
  });
}
