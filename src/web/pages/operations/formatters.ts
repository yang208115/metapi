import type { OperationsScope } from '../../../server/shared/operationsContract.js';

export function count(value: number): string {
  return value.toLocaleString('zh-CN');
}

export function percent(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(2)}%`;
}

export function duration(value: number | null): string {
  if (value == null) return '—';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

export function time(value: string, date = false): string {
  return new Date(value).toLocaleString('zh-CN', {
    ...(date ? { month: '2-digit', day: '2-digit' } as const : {}),
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

export function attemptLogsLink(scope: Pick<OperationsScope, 'from' | 'to' | 'siteId'>, failed = false): string {
  const params = new URLSearchParams({ from: scope.from, to: scope.to });
  if (scope.siteId != null) params.set('siteId', String(scope.siteId));
  if (failed) params.set('status', 'failed');
  return `/logs?${params}`;
}

export const statusLabels: Record<string, string> = {
  success: '完整成功', failed: '失败', cancelled: '已取消', rejected: '被拒绝', unknown: '结果未知',
};

export const failureLabels: Record<string, string> = {
  no_channel: '无可用通道', rate_limited: '限流', upstream_error: '上游故障',
  timeout: '超时', authentication: '鉴权失败', policy_rejected: '策略拒绝',
  cancelled: '客户端取消', stream_interrupted: '流式中断', unknown: '未分类',
  server_error: '服务端错误', client_error: '请求错误',
  rate_limit: '限流', upstream_overloaded: '上游过载', network: '网络异常',
  upstream_failure: '上游失败',
};
