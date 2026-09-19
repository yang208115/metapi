import { clearAuthSession, getAuthToken } from "./authSession.js";

type BufferLike = {
  from(data: ArrayBuffer): { toString(encoding: "base64"): string };
};

const nodeBuffer = (globalThis as typeof globalThis & { Buffer?: BufferLike })
  .Buffer;

type RequestOptions = RequestInit & {
  timeoutMs?: number;
};

function requireAuthToken(): string {
  const token = getAuthToken(localStorage);
  if (!token) {
    const hadToken = !!localStorage.getItem("auth_token");
    clearAuthSession(localStorage);
    if (
      hadToken &&
      typeof window !== "undefined" &&
      typeof window.location?.reload === "function"
    ) {
      window.location.reload();
    }
    throw new Error("Session expired");
  }
  return token;
}

async function extractResponseErrorMessage(res: Response): Promise<string> {
  let message = `HTTP ${res.status}`;
  try {
    const text = await res.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        if (json?.message && typeof json.message === "string") {
          message = json.message;
        } else if (json?.error && typeof json.error === "string") {
          message = json.error;
        } else if (
          json?.error?.message &&
          typeof json.error.message === "string"
        ) {
          message = json.error.message;
        } else {
          message = `${message}: ${text.slice(0, 120)}`;
        }
      } catch {
        message = `${message}: ${text.slice(0, 120)}`;
      }
    }
  } catch {}
  return message;
}

function parseContentDispositionFilename(
  headerValue: string | null,
): string | null {
  if (!headerValue) return null;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(headerValue);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const quotedMatch = /filename="([^"]+)"/i.exec(headerValue);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const bareMatch = /filename=([^;]+)/i.exec(headerValue);
  return bareMatch?.[1]?.trim() || null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (nodeBuffer) {
    return nodeBuffer.from(buffer).toString("base64");
  }

  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function fetchAuthenticatedResponse(
  url: string,
  options: RequestOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 30_000,
    signal: externalSignal,
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = timeoutMs > 0
    ? setTimeout(() => {
        controller.abort();
      }, timeoutMs)
    : null;
  let cleanupExternalSignal = () => {};

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      const abortHandler = () => controller.abort();
      externalSignal.addEventListener("abort", abortHandler, { once: true });
      cleanupExternalSignal = () =>
        externalSignal.removeEventListener("abort", abortHandler);
    }
  }

  const token = requireAuthToken();
  const headers = new Headers(fetchOptions.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  if (fetchOptions.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers,
    });
    if (res.status === 401 || res.status === 403) {
      const hadToken = !!getAuthToken(localStorage);
      clearAuthSession(localStorage);
      if (
        hadToken &&
        typeof window !== "undefined" &&
        typeof window.location?.reload === "function"
      ) {
        window.location.reload();
      }
      throw new Error("Session expired");
    }
    return res;
  } catch (error: any) {
    if (error?.name === "AbortError") {
      if (externalSignal?.aborted) throw error;
      throw new Error(
        `请求超时（${Math.max(1, Math.round(timeoutMs / 1000))}s）`,
      );
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    cleanupExternalSignal();
  }
}

async function request<T = any>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const res = await fetchAuthenticatedResponse(url, options);
  if (!res.ok) {
    throw new Error(await extractResponseErrorMessage(res));
  }
  return res.json() as Promise<T>;
}

async function streamSse(
  url: string,
  handlers: {
    onLog?: (entry: any) => void;
    onDone?: (payload: any) => void;
    onOpen?: () => void;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
) {
  const response = await fetchAuthenticatedResponse(url, {
    method: "GET",
    signal: handlers.signal,
    headers: {
      Accept: "text/event-stream",
    },
    timeoutMs: handlers.timeoutMs ?? 120_000,
  });

  if (!response.ok) {
    throw new Error(await extractResponseErrorMessage(response));
  }
  if (!response.body) {
    throw new Error("响应未返回流式内容");
  }
  handlers.onOpen?.();

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  const flushBuffer = (final = false) => {
    const chunks = final ? [...buffer.split("\n\n"), ""] : buffer.split("\n\n");
    if (!final) buffer = chunks.pop() || "";
    else buffer = "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      let eventName = "message";
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim() || "message";
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }

      if (dataLines.length <= 0) continue;
      let payload: any = dataLines.join("\n");
      try {
        payload = JSON.parse(payload);
      } catch {
        // keep string payload
      }

      if (eventName === "log") {
        handlers.onLog?.(payload);
      } else if (eventName === "done") {
        handlers.onDone?.(payload);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flushBuffer(false);
  }

  if (buffer.trim()) {
    flushBuffer(true);
  }
}

function buildQueryString(
  params?: Record<string, string | number | boolean | null | undefined>,
) {
  if (!params) return "";
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    searchParams.set(key, String(value));
  }
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : "";
}

type TestChatRequestPayload = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  targetFormat?: "openai" | "claude" | "responses" | "gemini";
  stream?: boolean;
  forcedChannelId?: number | null;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
};

export type ProxyTestMethod = "POST" | "GET" | "DELETE";
export type ProxyTestRequestKind = "json" | "multipart" | "empty";

export type ProxyTestMultipartFile = {
  field: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

export type ProxyTestRequestEnvelope = {
  method: ProxyTestMethod;
  path: string;
  requestKind: ProxyTestRequestKind;
  stream?: boolean;
  jobMode?: boolean;
  rawMode?: boolean;
  forcedChannelId?: number | null;
  jsonBody?: unknown;
  rawJsonText?: string;
  multipartFields?: Record<string, string>;
  multipartFiles?: ProxyTestMultipartFile[];
};

const DEFAULT_PROXY_TEST_TIMEOUT_MS = 30_000;
const LONG_RUNNING_PROXY_TEST_TIMEOUT_MS = 150_000;

function resolveProxyTestTimeoutMs(data: ProxyTestRequestEnvelope) {
  if (data.jobMode) return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === "/v1/images/generations")
    return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === "/v1/images/edits")
    return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  return DEFAULT_PROXY_TEST_TIMEOUT_MS;
}

function proxyTestRequest(data: ProxyTestRequestEnvelope) {
  return request("/api/test/proxy", {
    method: "POST",
    body: JSON.stringify(data),
    timeoutMs: resolveProxyTestTimeoutMs(data),
  });
}

async function proxyTestStreamRequest(
  data: ProxyTestRequestEnvelope,
  signal?: AbortSignal,
) {
  return fetchAuthenticatedResponse("/api/test/proxy/stream", {
    method: "POST",
    signal,
    body: JSON.stringify(data),
    timeoutMs: resolveProxyTestTimeoutMs(data),
  });
}

export type ProxyTestJobResponse = {
  jobId: string;
  status: "pending" | "succeeded" | "failed" | "cancelled";
  result?: unknown;
  error?: unknown;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
};

export type SystemProxyTestRequest = {
  proxyUrl?: string;
};

export type SystemProxyTestResponse = {
  success: true;
  proxyUrl: string;
  probeUrl: string;
  finalUrl: string;
  reachable: true;
  ok: boolean;
  statusCode: number;
  latencyMs: number;
};

export type RuntimeRoutingWeightsPayload = {
  baseWeightFactor?: number;
  valueScoreFactor?: number;
  costWeight?: number;
  balanceWeight?: number;
  usageWeight?: number;
};

export type RuntimeSettingsPayload = {
  proxyToken?: string;
  systemProxyUrl?: string;
  payloadRules?: Record<string, unknown> | null;
  codexUpstreamWebsocketEnabled?: boolean;
  responsesCompactFallbackToResponsesEnabled?: boolean;
  disableCrossProtocolFallback?: boolean;
  proxySessionChannelConcurrencyLimit?: number;
  proxySessionChannelQueueWaitMs?: number;
  proxyDebugTraceEnabled?: boolean;
  proxyDebugCaptureHeaders?: boolean;
  proxyDebugCaptureBodies?: boolean;
  proxyDebugCaptureStreamChunks?: boolean;
  proxyDebugTargetSessionId?: string;
  proxyDebugTargetClientKind?: string;
  proxyDebugTargetModel?: string;
  proxyDebugRetentionHours?: number;
  proxyDebugMaxBodyBytes?: number;
  logCleanupCron?: string;
  logCleanupUsageLogsEnabled?: boolean;
  logCleanupRetentionDays?: number;
  webhookUrl?: string;
  barkUrl?: string;
  webhookEnabled?: boolean;
  barkEnabled?: boolean;
  serverChanEnabled?: boolean;
  serverChanKey?: string;
  telegramEnabled?: boolean;
  telegramApiBaseUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramUseSystemProxy?: boolean;
  telegramMessageThreadId?: string;
  smtpEnabled?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  smtpTo?: string;
  notifyCooldownSec?: number;
  adminIpAllowlist?: string[] | string;
  routingFallbackUnitCost?: number;
  proxyFirstByteTimeoutSec?: number;
  tokenRouterFailureCooldownMaxSec?: number;
  routingWeights?: RuntimeRoutingWeightsPayload;
  proxyErrorKeywords?: string[] | string;
  proxyEmptyContentFailEnabled?: boolean;
  globalBlockedBrands?: string[];
  globalAllowedModels?: string[];
};

export type ProxyLogStatusFilter = "all" | "success" | "failed";
export type ProxyLogClientConfidence = "exact" | "heuristic" | "unknown" | null;
export type ProxyLogUsageSource = "upstream" | "self-log" | "unknown" | null;

export type TerminalLogEntry = {
  id: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  source: "console" | "fastify";
  message: string;
};

export type ProxyLogBillingDetails = {
  quotaType: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    billablePromptTokens: number;
    promptTokensIncludeCache: boolean | null;
  };
  pricing: {
    modelRatio: number;
    completionRatio: number;
    cacheRatio: number;
    cacheCreationRatio: number;
    groupRatio: number;
  };
  breakdown: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion: number;
    cacheCreationPerMillion: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheCreationCost: number;
    totalCost: number;
  };
} | null;

export type ProxyLogListItem = {
  id: number;
  createdAt: string;
  modelRequested: string;
  modelActual: string;
  status: string;
  latencyMs: number;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  totalTokens: number | null;
  retryCount: number;
  accountId?: number | null;
  siteId?: number | null;
  username?: string | null;
  siteName?: string | null;
  siteUrl?: string | null;
  errorMessage?: string | null;
  downstreamKeyId?: number | null;
  downstreamKeyName?: string | null;
  downstreamKeyGroupName?: string | null;
  downstreamKeyTags?: string[];
  clientFamily?: string | null;
  clientAppId?: string | null;
  clientAppName?: string | null;
  clientConfidence?: ProxyLogClientConfidence;
  usageSource?: ProxyLogUsageSource;
  promptTokens?: number | null;
  completionTokens?: number | null;
  estimatedCost?: number | null;
};

export type ProxyLogDetail = ProxyLogListItem & {
  routeId?: number | null;
  channelId?: number | null;
  httpStatus?: number | null;
  billingDetails?: ProxyLogBillingDetails;
};

export type ProxyLogsSummary = {
  totalCount: number;
  successCount: number;
  failedCount: number;
  totalCost: number;
  totalTokensAll: number;
  businessLimitCount?: number;
  averageLatencyMs?: number | null;
  averageFirstByteLatencyMs?: number | null;
};

export type ProxyLogsQuery = {
  limit?: number;
  offset?: number;
  status?: ProxyLogStatusFilter;
  search?: string;
  client?: string;
  siteId?: number;
  from?: string;
  to?: string;
};

export type ProxyLogClientOption = {
  value: string;
  label: string;
};

export type ProxyLogsResponse = {
  items: ProxyLogListItem[];
  total: number;
  page: number;
  pageSize: number;
  clientOptions: ProxyLogClientOption[];
  summary: ProxyLogsSummary;
};

export type ProxyDebugTraceListItem = {
  id: number;
  createdAt: string;
  downstreamPath: string;
  clientKind?: string | null;
  sessionId?: string | null;
  requestedModel?: string | null;
  selectedChannelId?: number | null;
  finalStatus?: string | null;
  finalHttpStatus?: number | null;
  finalUpstreamPath?: string | null;
};

export type ProxyDebugTraceDetail = {
  trace: {
    id: number;
    createdAt?: string | null;
    updatedAt?: string | null;
    downstreamPath?: string | null;
    clientKind?: string | null;
    sessionId?: string | null;
    traceHint?: string | null;
    requestedModel?: string | null;
    stickySessionKey?: string | null;
    stickyHitChannelId?: number | null;
    selectedChannelId?: number | null;
    selectedRouteId?: number | null;
    selectedAccountId?: number | null;
    selectedSiteId?: number | null;
    selectedSitePlatform?: string | null;
    endpointCandidatesJson?: string | null;
    endpointRuntimeStateJson?: string | null;
    decisionSummaryJson?: string | null;
    requestHeadersJson?: string | null;
    requestBodyJson?: string | null;
    finalStatus?: string | null;
    finalHttpStatus?: number | null;
    finalUpstreamPath?: string | null;
    finalResponseHeadersJson?: string | null;
    finalResponseBodyJson?: string | null;
  };
  attempts: Array<{
    id: number;
    attemptIndex: number;
    endpoint: string;
    requestPath: string;
    targetUrl: string;
    runtimeExecutor?: string | null;
    requestHeadersJson?: string | null;
    requestBodyJson?: string | null;
    responseStatus?: number | null;
    responseHeadersJson?: string | null;
    responseBodyJson?: string | null;
    rawErrorText?: string | null;
    recoverApplied?: boolean | null;
    downgradeDecision?: boolean | null;
    downgradeReason?: string | null;
    memoryWriteJson?: string | null;
    createdAt?: string | null;
  }>;
};

export type ProxyDebugTracesResponse = {
  items: ProxyDebugTraceListItem[];
};

export type DownstreamApiKeyTrendBucket = {
  startUtc: string | null;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  successRate: number | null;
  totalTokens: number;
  totalCost: number;
};

export type DownstreamApiKeyTrendResponse = {
  success: boolean;
  range: "24h" | "7d" | "all";
  item: {
    id: number;
    name: string;
  };
  bucketSeconds: number;
  timeZone?: string | null;
  buckets: DownstreamApiKeyTrendBucket[];
};

export const api = {
  // Sites
  getSites: () => request("/api/sites"),
  addSite: (data: any) =>
    request("/api/sites", { method: "POST", body: JSON.stringify(data) }),
  updateSite: (id: number, data: any) =>
    request(`/api/sites/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteSite: (id: number) => request(`/api/sites/${id}`, { method: "DELETE" }),
  batchUpdateSites: (data: any) =>
    request("/api/sites/batch", { method: "POST", body: JSON.stringify(data) }),
  detectSite: (url: string) =>
    request("/api/sites/detect", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  getSiteDisabledModels: (siteId: number) =>
    request(`/api/sites/${siteId}/disabled-models`),
  updateSiteDisabledModels: (siteId: number, models: string[]) =>
    request(`/api/sites/${siteId}/disabled-models`, {
      method: "PUT",
      body: JSON.stringify({ models }),
    }),
  getSiteAvailableModels: (siteId: number) =>
    request(`/api/sites/${siteId}/available-models`),
  // Accounts
  getAccounts: async (params?: { includeOauth?: boolean }) => {
    const result = await request<any>(`/api/accounts${buildQueryString(params)}`);
    return Array.isArray(result?.accounts) ? result.accounts : result;
  },
  getAccountsSnapshot: (options?: { refresh?: boolean }) =>
    request(
      `/api/accounts${buildQueryString(options?.refresh ? { refresh: 1 } : undefined)}`,
    ) as Promise<{
      generatedAt: string;
      accounts: any[];
      sites: any[];
    }>,
  addAccount: (data: any) =>
    request("/api/accounts", { method: "POST", body: JSON.stringify(data) }),
  loginAccount: (data: {
    siteId: number;
    username: string;
    password: string;
  }) =>
    request("/api/accounts/login", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  verifyToken: (data: {
    siteId: number;
    accessToken: string;
    platformUserId?: number;
    credentialMode?: "auto" | "session" | "apikey";
  }) =>
    request("/api/accounts/verify-token", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  rebindAccountSession: (
    id: number,
    data: {
      accessToken: string;
      platformUserId?: number;
      refreshToken?: string;
      tokenExpiresAt?: number;
    },
  ) =>
    request(`/api/accounts/${id}/rebind-session`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAccount: (id: number, data: any) =>
    request(`/api/accounts/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteAccount: (id: number) =>
    request(`/api/accounts/${id}`, { method: "DELETE" }),
  batchUpdateAccounts: (data: any) =>
    request("/api/accounts/batch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  refreshBalance: (id: number) =>
    request(`/api/accounts/${id}/balance`, { method: "POST" }),
  getAccountModels: (id: number) => request(`/api/accounts/${id}/models`),
  addAccountAvailableModels: (accountId: number, models: string[]) =>
    request(`/api/accounts/${accountId}/models/manual`, {
      method: "POST",
      body: JSON.stringify({ models }),
    }),
  removeAccountManualModels: (accountId: number, models: string[]) =>
    request(`/api/accounts/${accountId}/models/manual`, {
      method: "DELETE",
      body: JSON.stringify({ models }),
    }),
  refreshAccountHealth: (data?: { accountId?: number; wait?: boolean }) =>
    request("/api/accounts/health/refresh", {
      method: "POST",
      body: JSON.stringify(data || {}),
      timeoutMs: data?.wait ? 150_000 : 30_000,
    }),

  // Account tokens
  getAccountTokens: (accountId?: number) =>
    request(`/api/account-tokens${accountId ? `?accountId=${accountId}` : ""}`),
  addAccountToken: (data: any) =>
    request("/api/account-tokens", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAccountToken: (id: number, data: any) =>
    request(`/api/account-tokens/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteAccountToken: (id: number) =>
    request(`/api/account-tokens/${id}`, { method: "DELETE" }),
  batchUpdateAccountTokens: (data: any) =>
    request("/api/account-tokens/batch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getAccountTokenGroups: (accountId: number) =>
    request(`/api/account-tokens/groups/${accountId}`),
  setDefaultAccountToken: (id: number) =>
    request(`/api/account-tokens/${id}/default`, { method: "POST" }),
  getAccountTokenValue: (id: number) =>
    request(`/api/account-tokens/${id}/value`),
  syncAccountTokens: (accountId: number) =>
    request(`/api/account-tokens/sync/${accountId}`, {
      method: "POST",
      timeoutMs: 45_000,
    }),
  syncAllAccountTokens: (wait = false) =>
    request("/api/account-tokens/sync-all", {
      method: "POST",
      body: JSON.stringify(wait ? { wait: true } : {}),
      timeoutMs: wait ? 150_000 : 30_000,
    }),

  // Routes
  getRoutes: () => request("/api/routes"),
  getRoutesLite: () => request("/api/routes/lite"),
  getRoutesSummary: () => request("/api/routes/summary"),
  getRouteChannels: (routeId: number) =>
    request(`/api/routes/${routeId}/channels`),
  batchAddChannels: (
    routeId: number,
    channels: Array<{
      accountId: number;
      tokenId?: number;
      sourceModel?: string;
    }>,
  ) =>
    request(`/api/routes/${routeId}/channels/batch`, {
      method: "POST",
      body: JSON.stringify({ channels }),
    }),
  addRoute: (data: any) =>
    request("/api/routes", { method: "POST", body: JSON.stringify(data) }),
  updateRoute: (id: number, data: any) =>
    request(`/api/routes/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteRoute: (id: number) =>
    request(`/api/routes/${id}`, { method: "DELETE" }),
  clearRouteCooldown: (id: number) =>
    request(`/api/routes/${id}/cooldown/clear`, { method: "POST" }),
  batchUpdateRoutes: (data: { ids: number[]; action: "enable" | "disable" }) =>
    request("/api/routes/batch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  addChannel: (routeId: number, data: any) =>
    request(`/api/routes/${routeId}/channels`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateChannel: (id: number, data: any) =>
    request(`/api/channels/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  batchUpdateChannels: (updates: Array<{ id: number; priority: number }>) =>
    request("/api/channels/batch", {
      method: "PUT",
      body: JSON.stringify({ updates }),
    }),
  deleteChannel: (id: number) =>
    request(`/api/channels/${id}`, { method: "DELETE" }),
  rebuildRoutes: (refreshModels = true, wait = false) =>
    request("/api/routes/rebuild", {
      method: "POST",
      body: JSON.stringify({ refreshModels, ...(wait ? { wait: true } : {}) }),
      timeoutMs: wait ? 150_000 : 30_000,
    }),
  refreshRouteDecisionSnapshots: () =>
    request("/api/routes/decision/refresh", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  getRouteDecision: (model: string) =>
    request(`/api/routes/decision?model=${encodeURIComponent(model)}`),
  getRouteDecisionsBatch: (
    models: string[],
    options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean },
  ) =>
    request("/api/routes/decision/batch", {
      method: "POST",
      body: JSON.stringify({
        models,
        ...(options?.refreshPricingCatalog
          ? { refreshPricingCatalog: true }
          : {}),
        ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
      }),
    }),
  getRouteDecisionsByRouteBatch: (
    items: Array<{ routeId: number; model: string }>,
    options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean },
  ) =>
    request("/api/routes/decision/by-route/batch", {
      method: "POST",
      body: JSON.stringify({
        items,
        ...(options?.refreshPricingCatalog
          ? { refreshPricingCatalog: true }
          : {}),
        ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
      }),
    }),
  getRouteWideDecisionsBatch: (
    routeIds: number[],
    options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean },
  ) =>
    request("/api/routes/decision/route-wide/batch", {
      method: "POST",
      body: JSON.stringify({
        routeIds,
        ...(options?.refreshPricingCatalog
          ? { refreshPricingCatalog: true }
          : {}),
        ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
      }),
    }),

  // Stats
  streamTerminalLogs: (handlers: {
    onOpen?: () => void;
    onLog: (entry: TerminalLogEntry) => void;
    signal?: AbortSignal;
    limit?: number;
  }) =>
    streamSse(
      `/api/system/terminal-logs/stream${buildQueryString({
        limit: handlers.limit ?? 300,
      })}`,
      {
        onOpen: handlers.onOpen,
        onLog: handlers.onLog,
        signal: handlers.signal,
        timeoutMs: 0,
      },
    ),
  getDashboard: () => request("/api/stats/dashboard"),
  getDashboardSnapshot: (options?: { refresh?: boolean }) =>
    request(
      `/api/stats/dashboard${buildQueryString({
        view: "summary",
        ...(options?.refresh ? { refresh: 1 } : {}),
      })}`,
    ),
  getDashboardInsights: (options?: { refresh?: boolean }) =>
    request(
      `/api/stats/dashboard${buildQueryString({
        view: "insights",
        ...(options?.refresh ? { refresh: 1 } : {}),
      })}`,
    ),
  getProxyLogs: (params?: ProxyLogsQuery) =>
    request(
      `/api/stats/proxy-logs${buildQueryString(params)}`,
    ) as Promise<ProxyLogsResponse>,
  getProxyLogsQuery: (params?: ProxyLogsQuery) =>
    request(
      `/api/stats/proxy-logs${buildQueryString({
        ...params,
        view: "query",
      })}`,
    ) as Promise<{
      items: ProxyLogsResponse["items"];
      total: number;
      page: number;
      pageSize: number;
    }>,
  getProxyLogsMeta: (
    params?: Omit<ProxyLogsQuery, "limit" | "offset"> & {
      refresh?: number | boolean;
    },
  ) => {
    const refresh =
      params?.refresh === true
        ? 1
        : typeof params?.refresh === "number"
          ? params.refresh
          : undefined;
    const queryParams = {
      ...params,
      view: "meta",
      ...(refresh !== undefined ? { refresh } : {}),
    } as Record<string, string | number | boolean | null | undefined>;
    if (refresh === undefined) delete queryParams.refresh;
    return request(
      `/api/stats/proxy-logs${buildQueryString(queryParams)}`,
    ) as Promise<{
      clientOptions: ProxyLogsResponse["clientOptions"];
      summary: ProxyLogsResponse["summary"];
      sites: Array<{ id: number; name: string; status?: string | null }>;
    }>;
  },
  getProxyLogsWindow: (
    params?: Omit<ProxyLogsQuery, "limit" | "offset"> & {
      bucketCount?: number;
    },
  ) =>
    request(
      `/api/stats/proxy-logs${buildQueryString({
        ...params,
        view: "window",
      })}`,
    ) as Promise<{
      bucketDurationMs: number;
      peakQps: number;
      buckets: Array<{
        requestCount: number;
        successCount: number;
        failedCount: number;
        businessLimitCount: number;
        totalTokens: number;
      }>;
    }>,
  getDashboardWindowMetrics: async (params?: {
    siteIds?: number[];
    windowMinutes?: number;
  }) => {
    const windowMinutes = Math.max(
      1,
      Math.min(60, Math.trunc(params?.windowMinutes || 1)),
    );
    const to = new Date();
    const from = new Date(to.getTime() - windowMinutes * 60_000);
    const hasSiteScope = Array.isArray(params?.siteIds);
    const siteIds = hasSiteScope ? params.siteIds || [] : [undefined];
    if (hasSiteScope && siteIds.length === 0) {
      return {
        windowMinutes,
        totalCount: 0,
        successCount: 0,
        failedCount: 0,
        businessLimitCount: 0,
        totalCost: 0,
        totalTokensAll: 0,
        averageLatencyMs: null,
        averageFirstByteLatencyMs: null,
        peakQps: 0,
        buckets: Array.from({ length: 20 }, () => ({
          requestCount: 0,
          successCount: 0,
          failedCount: 0,
          businessLimitCount: 0,
          totalTokens: 0,
        })),
      };
    }
    const [summaries, windows] = await Promise.all([
      Promise.all(
        siteIds.map((siteId) =>
          api.getProxyLogsMeta({
            siteId,
            from: from.toISOString(),
            to: to.toISOString(),
          }),
        ),
      ),
      Promise.all(
        siteIds.map((siteId) =>
          api.getProxyLogsWindow({
            siteId,
            from: from.toISOString(),
            to: to.toISOString(),
            bucketCount: 20,
          }),
        ),
      ),
    ]);
    const summary = summaries.reduce(
      (total, current) => ({
        totalCount: total.totalCount + current.summary.totalCount,
        successCount: total.successCount + current.summary.successCount,
        failedCount: total.failedCount + current.summary.failedCount,
        totalCost: total.totalCost + current.summary.totalCost,
        totalTokensAll: total.totalTokensAll + current.summary.totalTokensAll,
        businessLimitCount:
          total.businessLimitCount + (current.summary.businessLimitCount || 0),
        latencyWeight:
          total.latencyWeight +
          (current.summary.averageLatencyMs || 0) * current.summary.totalCount,
        firstByteLatencyWeight:
          total.firstByteLatencyWeight +
          (current.summary.averageFirstByteLatencyMs || 0) *
            current.summary.totalCount,
      }),
      {
        totalCount: 0,
        successCount: 0,
        failedCount: 0,
        totalCost: 0,
        totalTokensAll: 0,
        businessLimitCount: 0,
        latencyWeight: 0,
        firstByteLatencyWeight: 0,
      },
    );
    const buckets = Array.from({ length: 20 }, (_, index) =>
      windows.reduce(
        (bucket, current) => {
          const source = current.buckets[index];
          if (!source) return bucket;
          return {
            requestCount: bucket.requestCount + source.requestCount,
            successCount: bucket.successCount + source.successCount,
            failedCount: bucket.failedCount + source.failedCount,
            businessLimitCount:
              bucket.businessLimitCount + source.businessLimitCount,
            totalTokens: bucket.totalTokens + source.totalTokens,
          };
        },
        {
          requestCount: 0,
          successCount: 0,
          failedCount: 0,
          businessLimitCount: 0,
          totalTokens: 0,
        },
      ),
    );
    const bucketSeconds = (windowMinutes * 60) / 20;
    return {
      windowMinutes,
      totalCount: summary.totalCount,
      successCount: summary.successCount,
      failedCount: summary.failedCount,
      totalCost: summary.totalCost,
      totalTokensAll: summary.totalTokensAll,
      businessLimitCount: summary.businessLimitCount,
      averageLatencyMs: summary.totalCount
        ? Math.round(summary.latencyWeight / summary.totalCount)
        : null,
      averageFirstByteLatencyMs: summary.totalCount
        ? Math.round(summary.firstByteLatencyWeight / summary.totalCount)
        : null,
      peakQps: Math.max(
        0,
        ...buckets.map((bucket) => bucket.requestCount / bucketSeconds),
      ),
      buckets,
    };
  },
  getProxyLogDetail: (id: number) =>
    request(`/api/stats/proxy-logs/${id}`) as Promise<ProxyLogDetail>,
  getProxyDebugTraces: (params?: { limit?: number }) =>
    request(
      `/api/stats/proxy-debug/traces${buildQueryString(params)}`,
    ) as Promise<ProxyDebugTracesResponse>,
  getProxyDebugTraceDetail: (id: number) =>
    request(
      `/api/stats/proxy-debug/traces/${id}`,
    ) as Promise<ProxyDebugTraceDetail>,
  checkModels: (accountId: number) =>
    request(`/api/models/check/${accountId}`, { method: "POST" }),
  getSiteDistribution: () => request("/api/stats/site-distribution"),
  getSiteTrend: (days = 7) => request(`/api/stats/site-trend?days=${days}`),
  getSiteSnapshot: async (days = 7, options?: { refresh?: boolean }) => {
    const query = buildQueryString({
      days,
      ...(options?.refresh ? { refresh: 1 } : {}),
    });
    const [distribution, trend, sites] = await Promise.all([
      request<{ distribution: any[] }>(`/api/stats/site-distribution${query}`),
      request<{ trend: any[] }>(`/api/stats/site-trend${query}`),
      request<any[]>("/api/sites"),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      distribution: Array.isArray(distribution?.distribution)
        ? distribution.distribution
        : [],
      trend: Array.isArray(trend?.trend) ? trend.trend : [],
      sites: Array.isArray(sites) ? sites : [],
    };
  },
  getModelBySite: (siteId?: number, days = 7) =>
    request(
      `/api/stats/model-by-site?${siteId ? `siteId=${siteId}&` : ""}days=${days}`,
    ),

  // Search
  search: (query: string) =>
    request("/api/search", {
      method: "POST",
      body: JSON.stringify({ query, limit: 20 }),
    }),

  getTasks: (limit = 50) =>
    request(
      `/api/tasks?limit=${Math.max(1, Math.min(200, Math.trunc(limit)))}`,
    ),
  getTask: (id: string) => request(`/api/tasks/${encodeURIComponent(id)}`),

  // Auth management
  getAuthInfo: () => request("/api/settings/auth/info"),
  changeAuthToken: (oldToken: string, newToken: string) =>
    request("/api/settings/auth/change", {
      method: "POST",
      body: JSON.stringify({ oldToken, newToken }),
    }),
  getRuntimeSettings: () => request("/api/settings/runtime"),
  getBrandList: () => request("/api/settings/brand-list"),
  updateRuntimeSettings: (data: RuntimeSettingsPayload) =>
    request("/api/settings/runtime", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  testSystemProxy: (data: SystemProxyTestRequest) =>
    request("/api/settings/system-proxy/test", {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: 20_000,
    }),
  getRuntimeDatabaseConfig: () => request("/api/settings/database/runtime"),
  updateRuntimeDatabaseConfig: (data: {
    dialect: "sqlite" | "mysql" | "postgres";
    connectionString: string;
    ssl?: boolean;
  }) =>
    request("/api/settings/database/runtime", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  testExternalDatabaseConnection: (data: {
    dialect: "sqlite" | "mysql" | "postgres";
    connectionString: string;
    ssl?: boolean;
  }) =>
    request("/api/settings/database/test-connection", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  migrateExternalDatabase: (data: {
    dialect: "sqlite" | "mysql" | "postgres";
    connectionString: string;
    overwrite?: boolean;
    ssl?: boolean;
  }) =>
    request("/api/settings/database/migrate", {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: 120_000,
    }),
  getDownstreamApiKeys: () => request("/api/downstream-keys"),
  createDownstreamApiKey: (data: any) =>
    request("/api/downstream-keys", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateDownstreamApiKey: (id: number, data: any) =>
    request(`/api/downstream-keys/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteDownstreamApiKey: (id: number) =>
    request(`/api/downstream-keys/${id}`, {
      method: "DELETE",
    }),
  batchDownstreamApiKeys: (data: {
    ids: number[];
    action: "enable" | "disable" | "delete" | "resetUsage" | "updateMetadata";
    groupOperation?: "keep" | "set" | "clear";
    groupName?: string;
    tagOperation?: "keep" | "append";
    tags?: string[];
  }) =>
    request("/api/downstream-keys/batch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  resetDownstreamApiKeyUsage: (id: number) =>
    request(`/api/downstream-keys/${id}/reset-usage`, {
      method: "POST",
    }),
  getDownstreamApiKeysSummary: (params?: {
    range?: "24h" | "7d" | "all";
    status?: "all" | "enabled" | "disabled";
    search?: string;
  }) => request(`/api/downstream-keys/summary${buildQueryString(params)}`),
  getDownstreamApiKeyOverview: (id: number) =>
    request(`/api/downstream-keys/${id}/overview`),
  getDownstreamApiKeyTrend: (
    id: number,
    params?: { range?: "24h" | "7d" | "all"; timeZone?: string },
  ) =>
    request<DownstreamApiKeyTrendResponse>(
      `/api/downstream-keys/${id}/trend${buildQueryString(params)}`,
    ),
  exportBackup: (type: "all" | "accounts" | "preferences" = "all") =>
    request(`/api/settings/backup/export?type=${encodeURIComponent(type)}`),
  importBackup: (data: any) =>
    request("/api/settings/backup/import", {
      method: "POST",
      body: JSON.stringify({ data }),
    }),
  clearRuntimeCache: () =>
    request("/api/settings/maintenance/clear-cache", { method: "POST" }),
  clearUsageData: () =>
    request("/api/settings/maintenance/clear-usage", { method: "POST" }),
  factoryReset: () =>
    request("/api/settings/maintenance/factory-reset", { method: "POST" }),
  testNotification: () =>
    request("/api/settings/notify/test", { method: "POST" }),

  getModels: () => request("/api/models"),
  getModelTokenCandidates: () => request("/api/models/token-candidates"),

  // Simple chat test from admin panel
  startTestChatJob: (data: TestChatRequestPayload) =>
    request("/api/test/chat/jobs", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getTestChatJob: (jobId: string) =>
    request(`/api/test/chat/jobs/${encodeURIComponent(jobId)}`),
  deleteTestChatJob: (jobId: string) =>
    request(`/api/test/chat/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }),
  startProxyTestJob: (data: ProxyTestRequestEnvelope) =>
    request("/api/test/proxy/jobs", {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: resolveProxyTestTimeoutMs(data),
    }),
  getProxyTestJob: (jobId: string) =>
    request(`/api/test/proxy/jobs/${encodeURIComponent(jobId)}`),
  deleteProxyTestJob: (jobId: string) =>
    request(`/api/test/proxy/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }),
  getProxyFileContentDataUrl: async (
    fileId: string,
    options: Pick<RequestOptions, "signal" | "timeoutMs"> = {},
  ) => {
    const response = await fetchAuthenticatedResponse(
      `/v1/files/${encodeURIComponent(fileId)}/content`,
      {
        method: "GET",
        ...options,
      },
    );
    if (!response.ok) {
      throw new Error(await extractResponseErrorMessage(response));
    }

    const mimeType =
      (response.headers.get("content-type") || "application/octet-stream")
        .split(";")[0]
        .trim() || "application/octet-stream";
    const filename = parseContentDispositionFilename(
      response.headers.get("content-disposition"),
    );
    const base64 = arrayBufferToBase64(await response.arrayBuffer());
    return {
      filename,
      mimeType,
      data: `data:${mimeType};base64,${base64}`,
    };
  },
  testProxy: proxyTestRequest,
  proxyTest: proxyTestRequest,
  testChat: (data: TestChatRequestPayload) =>
    request("/api/test/chat", { method: "POST", body: JSON.stringify(data) }),
  testProxyStream: proxyTestStreamRequest,
  proxyTestStream: proxyTestStreamRequest,
  testChatStream: async (
    data: TestChatRequestPayload,
    signal?: AbortSignal,
  ) => {
    const token = getAuthToken(localStorage);
    if (!token) {
      clearAuthSession(localStorage);
      throw new Error("Session expired");
    }
    return fetch("/api/test/chat/stream", {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  },
};
