import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, min } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export const PROXY_REQUEST_OUTCOME_STATUSES = [
  'success', 'failed', 'cancelled', 'rejected', 'unknown',
] as const;

export type ProxyRequestOutcomeStatus = (typeof PROXY_REQUEST_OUTCOME_STATUSES)[number];

export interface ProxyRequestOutcomeInput {
  requestId: string;
  startedAt: string;
  completedAt: string;
  downstreamPath: string;
  modelRequested: string | null;
  siteId: number | null;
  accountId: number | null;
  channelId: number | null;
  status: ProxyRequestOutcomeStatus;
  httpStatus: number | null;
  latencyMs: number;
  firstByteLatencyMs: number | null;
  attemptCount: number;
  failedAttemptCount: number;
  totalTokens: number | null;
  estimatedCost: number | null;
  errorClass: string | null;
  isStream: boolean;
}

export interface ProxyRequestTelemetryHealth {
  observedSince: string | null;
  pendingWrites: number;
  failedWrites: number;
  lastFailureAt: string | null;
  inFlight: number;
  observedSinceSource: 'outcomes' | null;
  notes: string[];
}

type ProxyRequestTelemetryContext = {
  requestId: string;
  startedAt: string;
  startedAtMs: number;
  downstreamPath: string;
  modelRequested: string | null;
  siteId: number | null;
  accountId: number | null;
  channelId: number | null;
  statusCandidate: string | null;
  httpStatus: number | null;
  firstByteLatencyMs: number | null;
  attemptCount: number;
  failedAttemptCount: number;
  totalTokens: number | null;
  estimatedCost: number | null;
  errorClass: string | null;
  isStream: boolean;
  handlerSettled: boolean;
  handlerStarted: boolean;
  earlyRejected: boolean;
  transportFinished: boolean;
  transportEndedAtMs: number | null;
  transportHttpStatus: number | null;
  outcomeFinalized: boolean;
};

type ProxyRequestFinalizationReason = 'response' | 'finish' | 'close' | 'error';

type ProxyLogAttemptLike = {
  siteId?: number | null;
  accountId?: number | null;
  channelId?: number | null;
  modelRequested?: string | null;
  status?: string | null;
  httpStatus?: number | null;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  totalTokens?: number | null;
  estimatedCost?: number | null;
  errorMessage?: string | null;
  errorClass?: string | null;
};

type OutcomeWriter = (input: ProxyRequestOutcomeInput) => Promise<void>;

const requestTelemetryStorage = new AsyncLocalStorage<ProxyRequestTelemetryContext>();
const requestTelemetryByRequest = new WeakMap<FastifyRequest, ProxyRequestTelemetryContext>();
const trackedFinalizations = new Set<Promise<void>>();

let pendingWrites = 0;
let failedWrites = 0;
let lastFailureAt: string | null = null;
let cachedObservedSince: string | null = null;
let inFlight = 0;
let outcomeWriter: OutcomeWriter = async (input) => {
  await db.insert(schema.proxyRequestOutcomes).values(input).run();
};

const TELEMETRY_NOTES = [
  '观测范围：HTTP 代理推理请求；已排除 GET /v1/models 与 /v1/files 管理请求',
  'WebSocket 升级请求绕过 Fastify 生命周期，当前未纳入观测',
  '历史 proxy_logs 没有 requestId，且不会用于推定观测起点',
];

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePath(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

function shouldObserveRequest(request: FastifyRequest): boolean {
  const path = normalizePath(request.url).toLowerCase();
  if (path === '/v1/models' || path.startsWith('/v1/models/')) return false;
  if (path === '/v1/files' || path.startsWith('/v1/files/')) return false;
  return request.method === 'POST';
}

function asRequestBody(request: FastifyRequest): Record<string, unknown> | null {
  const body = request.body;
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

function readModelFromRequest(request: FastifyRequest): string | null {
  const bodyModel = asRequestBody(request)?.model;
  if (typeof bodyModel === 'string' && bodyModel.trim()) return bodyModel.trim();
  const pathMatch = normalizePath(request.url).match(/\/models\/([^/:?]+)/i);
  return pathMatch?.[1] ? decodeURIComponent(pathMatch[1]) : null;
}

function readStreamFromRequest(request: FastifyRequest): boolean {
  const body = asRequestBody(request);
  if (body?.stream === true) return true;
  const path = normalizePath(request.url).toLowerCase();
  if (path.includes('streamgeneratecontent') || path.includes('/stream')) return true;
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.toLowerCase().includes('text/event-stream');
}

function normalizeErrorClass(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'no_channel') return 'no_channel';
  if (normalized.includes('abort') || normalized.includes('cancel')) return 'cancelled';
  if (normalized.includes('no available channel') || normalized.includes('no channel')) return 'no_channel';
  if (normalized.includes('unauthor') || normalized.includes('forbidden') || normalized.includes('authorization')) {
    return 'authentication';
  }
  if (normalized.includes('rate') || normalized.includes('quota') || normalized.includes('429')) return 'rate_limit';
  if (normalized.includes('529')) return 'upstream_overloaded';
  if (normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('network') || normalized.includes('fetch') || normalized.includes('socket')) return 'network';
  return 'upstream_failure';
}

function getContext(request?: FastifyRequest): ProxyRequestTelemetryContext | undefined {
  return (request && requestTelemetryByRequest.get(request)) || requestTelemetryStorage.getStore();
}

function syncRequestMetadata(context: ProxyRequestTelemetryContext, request: FastifyRequest): void {
  if (!context.modelRequested) context.modelRequested = readModelFromRequest(request);
  context.isStream = context.isStream || readStreamFromRequest(request);
}

function classifyFinalStatus(
  context: ProxyRequestTelemetryContext,
  reason: ProxyRequestFinalizationReason,
  httpStatus: number | null,
): ProxyRequestOutcomeStatus {
  if (reason === 'error') return 'failed';
  if (reason === 'close') return 'cancelled';
  if (httpStatus !== null && (httpStatus >= 500 || httpStatus === 429 || httpStatus === 529)) return 'failed';
  if (httpStatus !== null && httpStatus >= 400) return 'rejected';

  const candidate = (context.statusCandidate || '').toLowerCase();
  if (candidate === 'failed' || candidate === 'retried') return 'failed';
  if (candidate === 'cancelled') return 'cancelled';
  if (candidate === 'rejected') return 'rejected';
  if (context.isStream && reason === 'finish' && candidate === 'success') return 'success';
  if (context.isStream) return 'unknown';
  if (candidate === 'success' && (reason === 'finish' || reason === 'response')) return 'success';
  if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300
    && (reason === 'finish' || reason === 'response')) return 'success';
  return 'unknown';
}

async function resolveSiteId(accountId: number | null, siteId: number | null): Promise<number | null> {
  if (siteId !== null || accountId === null) return siteId;
  try {
    const rows = await db.select({ siteId: schema.accounts.siteId })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .limit(1)
      .all();
    return rows[0]?.siteId ?? null;
  } catch {
    return null;
  }
}

function enqueueOutcome(input: ProxyRequestOutcomeInput): Promise<void> {
  pendingWrites += 1;
  if (!cachedObservedSince || input.startedAt < cachedObservedSince) cachedObservedSince = input.startedAt;
  return Promise.resolve()
    .then(() => outcomeWriter(input))
    .catch((error) => {
      failedWrites += 1;
      lastFailureAt = nowIso();
      throw error;
    })
    .finally(() => {
      pendingWrites -= 1;
    });
}

export function insertProxyRequestOutcome(input: ProxyRequestOutcomeInput): Promise<void> {
  return enqueueOutcome(input);
}

export function getProxyRequestTelemetryHealthSync(): ProxyRequestTelemetryHealth {
  return {
    observedSince: cachedObservedSince,
    pendingWrites,
    failedWrites,
    lastFailureAt,
    inFlight,
    observedSinceSource: cachedObservedSince ? 'outcomes' : null,
    notes: [...TELEMETRY_NOTES],
  };
}

export async function getProxyRequestTelemetryHealth(): Promise<ProxyRequestTelemetryHealth> {
  let observedSince = cachedObservedSince;
  let observedSinceSource: ProxyRequestTelemetryHealth['observedSinceSource'] = observedSince ? 'outcomes' : null;
  try {
    const rows = await db.select({ observedSince: min(schema.proxyRequestOutcomes.startedAt) })
      .from(schema.proxyRequestOutcomes)
      .all();
    const value = rows[0]?.observedSince;
    if (typeof value === 'string' && value.trim()) {
      observedSince = !observedSince || value < observedSince ? value : observedSince;
      observedSinceSource = 'outcomes';
    }
  } catch {
    // Health reads must not affect request handling.
  }
  return { observedSince, pendingWrites, failedWrites, lastFailureAt, inFlight, observedSinceSource, notes: [...TELEMETRY_NOTES] };
}

export function recordProxyLogAttempt(input: ProxyLogAttemptLike): void {
  const context = getContext();
  if (!context) return;
  context.attemptCount += 1;
  const status = String(input.status || '').toLowerCase();
  const statusCode = input.httpStatus ?? null;
  if (status === 'failed' || status === 'retried' || (statusCode !== null && statusCode >= 400)) {
    context.failedAttemptCount += 1;
  }
  if (input.modelRequested?.trim()) context.modelRequested = input.modelRequested.trim();
  if (input.siteId !== undefined) context.siteId = input.siteId ?? null;
  if (input.accountId !== undefined) context.accountId = input.accountId ?? null;
  if (input.channelId !== undefined) context.channelId = input.channelId ?? null;
  if (input.httpStatus !== undefined && input.httpStatus !== null) context.httpStatus = input.httpStatus;
  if (input.isStream === true) context.isStream = true;
  if (input.firstByteLatencyMs !== undefined && input.firstByteLatencyMs !== null && input.firstByteLatencyMs >= 0) {
    context.firstByteLatencyMs = input.firstByteLatencyMs;
  }
  if (input.totalTokens !== undefined && input.totalTokens !== null) context.totalTokens = input.totalTokens;
  if (input.estimatedCost !== undefined && input.estimatedCost !== null) context.estimatedCost = input.estimatedCost;
  if (status) {
    context.statusCandidate = status;
    if (status === 'success') context.errorClass = null;
  }
  const errorClass = input.errorClass || normalizeErrorClass(input.errorMessage);
  if (errorClass) context.errorClass = errorClass;
}

export function recordProxyRequestError(request: FastifyRequest, error: unknown): void {
  const context = getContext(request);
  if (!context) return;
  context.statusCandidate = 'failed';
  context.errorClass = normalizeErrorClass(error instanceof Error ? error.message : String(error));
}

export function recordProxyRequestErrorClass(request: FastifyRequest, errorClass: string): void {
  const context = getContext(request);
  if (!context) return;
  context.statusCandidate = 'failed';
  context.errorClass = errorClass;
}

function maybeFinalizeProxyRequest(
  request: FastifyRequest,
  reason: ProxyRequestFinalizationReason,
  rawStatus: number | null,
): void {
  const context = getContext(request);
  if (!context || context.outcomeFinalized) return;
  if (context.isStream) {
    const transportStatus = context.transportHttpStatus ?? rawStatus ?? context.httpStatus;
    const earlyRejection = context.earlyRejected
      && context.transportFinished
      && transportStatus !== null
      && transportStatus >= 400;
    if (reason !== 'close' && reason !== 'error'
      && (!context.transportFinished || (!context.handlerSettled && !earlyRejection))) return;
  } else if (reason !== 'response' && reason !== 'finish' && reason !== 'close' && reason !== 'error') {
    return;
  }
  const finalization = finalizeProxyRequest(request, reason, rawStatus);
  trackedFinalizations.add(finalization);
  void finalization.then(
    () => trackedFinalizations.delete(finalization),
    () => trackedFinalizations.delete(finalization),
  );
}

export function markProxyRequestHandlerSettled(request: FastifyRequest): void {
  const context = getContext(request);
  if (!context) return;
  context.handlerSettled = true;
  if (context.isStream) maybeFinalizeProxyRequest(request, 'finish', context.httpStatus);
}

async function finalizeProxyRequest(
  request: FastifyRequest,
  reason: ProxyRequestFinalizationReason,
  rawStatus: number | null,
): Promise<void> {
  const context = getContext(request);
  if (!context || context.outcomeFinalized) return;
  syncRequestMetadata(context, request);
  context.outcomeFinalized = true;
  inFlight = Math.max(0, inFlight - 1);
  const endMs = context.transportEndedAtMs ?? Date.now();
  const completedAt = new Date(endMs).toISOString();
  const httpStatus = reason === 'finish'
    ? (context.transportHttpStatus ?? rawStatus ?? context.httpStatus)
    : (rawStatus ?? context.httpStatus);
  const status = classifyFinalStatus(context, reason, httpStatus);
  const outcome: ProxyRequestOutcomeInput = {
    requestId: context.requestId,
    startedAt: context.startedAt,
    completedAt,
    downstreamPath: context.downstreamPath,
    modelRequested: context.modelRequested,
    siteId: await resolveSiteId(context.accountId, context.siteId),
    accountId: context.accountId,
    channelId: context.channelId,
    status,
    httpStatus,
    latencyMs: Math.max(0, endMs - context.startedAtMs),
    firstByteLatencyMs: context.firstByteLatencyMs,
    attemptCount: context.attemptCount,
    failedAttemptCount: context.failedAttemptCount,
    totalTokens: context.totalTokens,
    estimatedCost: context.estimatedCost,
    errorClass: context.errorClass,
    isStream: context.isStream,
  };
  try {
    await insertProxyRequestOutcome(outcome);
  } catch {
    // The health counters retain the failure; request completion must not throw.
  }
}

function attachRawLifecycle(request: FastifyRequest, raw: ServerResponse): void {
  raw.once('finish', () => {
    const context = getContext(request);
    if (context) {
      context.transportFinished = true;
      context.transportEndedAtMs = Date.now();
      context.transportHttpStatus = Number.isFinite(raw.statusCode) ? raw.statusCode : context.httpStatus;
    }
    maybeFinalizeProxyRequest(request, 'finish', Number.isFinite(raw.statusCode) ? raw.statusCode : null);
  });
  raw.once('close', () => {
    if (raw.writableFinished) return;
    maybeFinalizeProxyRequest(request, 'close', Number.isFinite(raw.statusCode) ? raw.statusCode : null);
  });
  raw.once('error', (error) => {
    recordProxyRequestError(request, error);
    maybeFinalizeProxyRequest(request, 'error', Number.isFinite(raw.statusCode) ? raw.statusCode : null);
  });
  request.raw.once('aborted', () => {
    recordProxyRequestError(request, new Error('request aborted'));
    maybeFinalizeProxyRequest(request, 'close', Number.isFinite(raw.statusCode) ? raw.statusCode : null);
  });
}

function errorClassFromPayload(payload: unknown): string | null {
  let value: unknown = payload;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const error = record.error;
  const message = typeof record.message === 'string'
    ? record.message
    : typeof error === 'string'
      ? error
      : error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
        ? String((error as Record<string, unknown>).message)
        : '';
  return normalizeErrorClass(message);
}

export function installProxyRequestTelemetry(app: FastifyInstance): void {
  app.addHook('onRoute', (routeOptions) => {
    const originalHandler = routeOptions.handler;
    if (typeof originalHandler !== 'function') return;
    routeOptions.handler = async function wrappedProxyHandler(request, reply) {
      const context = getContext(request);
      if (context) context.handlerStarted = true;
      try {
        return await originalHandler.call(this, request, reply);
      } catch (error) {
        recordProxyRequestError(request, error);
        throw error;
      } finally {
        markProxyRequestHandlerSettled(request);
      }
    };
  });
  app.addHook('onRequest', (request, reply, done) => {
    if (!shouldObserveRequest(request)) {
      done();
      return;
    }
    const startedAtMs = Date.now();
    const context: ProxyRequestTelemetryContext = {
      requestId: randomUUID(),
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      downstreamPath: normalizePath(request.url),
      modelRequested: null,
      siteId: null,
      accountId: null,
      channelId: null,
      statusCandidate: null,
      httpStatus: null,
      firstByteLatencyMs: null,
      attemptCount: 0,
      failedAttemptCount: 0,
      totalTokens: null,
      estimatedCost: null,
      errorClass: null,
      isStream: readStreamFromRequest(request),
      handlerSettled: false,
      handlerStarted: false,
      earlyRejected: false,
      transportFinished: false,
      transportEndedAtMs: null,
      transportHttpStatus: null,
      outcomeFinalized: false,
    };
    requestTelemetryByRequest.set(request, context);
    inFlight += 1;
    requestTelemetryStorage.run(context, () => {
      attachRawLifecycle(request, reply.raw);
      done();
    });
  });
  app.addHook('onError', async (request, _reply, error) => {
    recordProxyRequestError(request, error);
  });
  const syncMetadata = async (request: FastifyRequest) => {
    const context = getContext(request);
    if (context) syncRequestMetadata(context, request);
  };
  app.addHook('preValidation', syncMetadata);
  app.addHook('preHandler', syncMetadata);
  app.addHook('onSend', async (request, reply, payload) => {
    const context = getContext(request);
    if (reply.statusCode >= 400) {
      if (context) {
        context.httpStatus = reply.statusCode;
        if (!context.handlerStarted) context.earlyRejected = true;
      }
      const errorClass = errorClassFromPayload(payload);
      if (errorClass) recordProxyRequestErrorClass(request, errorClass);
    }
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    const context = getContext(request);
    if (!context) return;
    syncRequestMetadata(context, request);
    if (Number.isFinite(reply.statusCode)) context.httpStatus = reply.statusCode;
    if (context.isStream) {
      if (!reply.raw.writableFinished) return;
      context.transportFinished = true;
      context.transportEndedAtMs ??= Date.now();
      context.transportHttpStatus = reply.statusCode;
      maybeFinalizeProxyRequest(request, 'finish', Number.isFinite(reply.statusCode) ? reply.statusCode : null);
      return;
    }
    maybeFinalizeProxyRequest(request, 'response', Number.isFinite(reply.statusCode) ? reply.statusCode : null);
  });
  app.addHook('onClose', async () => {
    while (trackedFinalizations.size > 0 || pendingWrites > 0) {
      const current = [...trackedFinalizations];
      if (current.length > 0) await Promise.all(current);
      if (pendingWrites > 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
}

export function __setProxyRequestOutcomeWriterForTests(writer: OutcomeWriter | null): () => void {
  const previous = outcomeWriter;
  outcomeWriter = writer || previous;
  return () => { outcomeWriter = previous; };
}

export function __resetProxyRequestTelemetryForTests(): void {
  pendingWrites = 0;
  failedWrites = 0;
  lastFailureAt = null;
  cachedObservedSince = null;
  inFlight = 0;
  trackedFinalizations.clear();
}

export function __finalizeProxyRequestForTests(
  request: FastifyRequest,
  reason: ProxyRequestFinalizationReason,
  httpStatus: number | null,
): Promise<void> {
  return finalizeProxyRequest(request, reason, httpStatus);
}

export function __markProxyRequestTransportFinishedForTests(request: FastifyRequest, httpStatus: number): void {
  const context = getContext(request);
  if (!context) return;
  context.transportFinished = true;
  context.transportEndedAtMs = Date.now();
  context.transportHttpStatus = httpStatus;
  maybeFinalizeProxyRequest(request, 'finish', httpStatus);
}
