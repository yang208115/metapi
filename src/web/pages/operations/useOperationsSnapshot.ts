import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import type { OperationsSnapshot, OperationsWindow } from '../../../server/shared/operationsContract.js';

export interface OperationsSelection {
  windowMinutes: OperationsWindow;
  liveWindowMinutes: number;
  siteId?: number;
  platform?: string;
}

export function useOperationsSnapshot(selection: OperationsSelection, paused: boolean) {
  const key = JSON.stringify(selection);
  const [result, setResult] = useState<{ key: string; data: OperationsSnapshot } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clock, setClock] = useState(Date.now());
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const lastLoad = useRef({ key: '', revision: -1 });
  const data = result?.key === key ? result.data : null;

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let busy = false;
    const generation = ++sequence.current;
    const load = async () => {
      if (busy || disposed) return;
      busy = true;
      controller = new AbortController();
      setLoading(true);
      try {
        const next = await api.getOperationsSnapshot(JSON.parse(key), controller.signal);
        if (!disposed && sequence.current === generation) {
          setResult({ key, data: next });
          setError(null);
          setClock(Date.now());
        }
      } catch (reason) {
        if (!disposed && sequence.current === generation) {
          setError(reason instanceof Error ? reason.message : '运维数据加载失败');
        }
      } finally {
        busy = false;
        if (!disposed && sequence.current === generation) setLoading(false);
      }
    };
    // A frozen snapshot stays intact until a scope change or explicit refresh.
    if (!paused || lastLoad.current.key !== key || lastLoad.current.revision !== revision) {
      lastLoad.current = { key, revision };
      void load();
    } else {
      setLoading(false);
    }
    const onVisible = () => {
      if (!paused && document.visibilityState === 'visible') void load();
    };
    const interval = setInterval(onVisible, 30_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, paused, revision]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const ageSeconds = data ? Math.max(0, Math.floor((clock - Date.parse(data.generatedAt)) / 1000)) : null;
  return {
    data, loading, error, refresh, ageSeconds,
    stale: !!error || (!paused && ageSeconds != null && ageSeconds > 90),
    filters: result?.data.filters ?? [],
  };
}
