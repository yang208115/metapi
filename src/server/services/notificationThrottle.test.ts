import { describe, expect, it } from 'vitest';
import {
  createNotificationSignature,
  evaluateNotificationThrottle,
  pruneNotificationThrottleState,
  type NotificationThrottleState,
} from './notificationThrottle.js';

describe('notificationThrottle', () => {
  it('suppresses duplicate notifications during cooldown and merges suppressed count after cooldown', () => {
    const state = new Map<string, NotificationThrottleState>();
    const signature = createNotificationSignature('代理全部失败', '模型=gpt-4o', 'error');

    const first = evaluateNotificationThrottle(state, signature, 1_000, 300_000);
    expect(first.shouldSend).toBe(true);
    expect(first.mergedCount).toBe(0);

    const second = evaluateNotificationThrottle(state, signature, 1_020, 300_000);
    expect(second.shouldSend).toBe(false);
    expect(second.mergedCount).toBe(0);

    const third = evaluateNotificationThrottle(state, signature, 301_100, 300_000);
    expect(third.shouldSend).toBe(true);
    expect(third.mergedCount).toBe(1);
  });

  it('prunes stale throttle state entries', () => {
    const state = new Map<string, NotificationThrottleState>();
    state.set('recent', { lastSentAtMs: 950_000, suppressedCount: 0 });
    state.set('stale', { lastSentAtMs: 1, suppressedCount: 3 });

    pruneNotificationThrottleState(state, 1_000_000, 60_000);

    expect(state.has('recent')).toBe(true);
    expect(state.has('stale')).toBe(false);
  });
});
