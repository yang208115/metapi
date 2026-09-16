export type NotificationThrottleState = {
  lastSentAtMs: number;
  suppressedCount: number;
};

export function createNotificationSignature(title: string, message: string, level: string): string {
  return [
    (level || '').trim().toLowerCase(),
    (title || '').trim(),
    (message || '').trim(),
  ].join('||');
}

export function evaluateNotificationThrottle(
  state: Map<string, NotificationThrottleState>,
  signature: string,
  nowMs: number,
  cooldownMs: number,
): { shouldSend: boolean; mergedCount: number } {
  if (cooldownMs <= 0) {
    return { shouldSend: true, mergedCount: 0 };
  }

  const current = state.get(signature);
  if (!current) {
    state.set(signature, { lastSentAtMs: nowMs, suppressedCount: 0 });
    return { shouldSend: true, mergedCount: 0 };
  }

  if (nowMs - current.lastSentAtMs < cooldownMs) {
    current.suppressedCount += 1;
    state.set(signature, current);
    return { shouldSend: false, mergedCount: 0 };
  }

  const mergedCount = current.suppressedCount;
  state.set(signature, { lastSentAtMs: nowMs, suppressedCount: 0 });
  return { shouldSend: true, mergedCount };
}

export function pruneNotificationThrottleState(
  state: Map<string, NotificationThrottleState>,
  nowMs: number,
  staleMs: number,
): void {
  if (staleMs <= 0) return;

  for (const [key, value] of state.entries()) {
    if (nowMs - value.lastSentAtMs > staleMs) {
      state.delete(key);
    }
  }
}
