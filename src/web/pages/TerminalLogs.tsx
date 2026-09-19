import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, type TerminalLogEntry } from '../api.js';
import { useI18n } from '../i18n.js';

type ConnectionState = 'connecting' | 'live' | 'reconnecting';
type LogEntry = TerminalLogEntry;

const LEVELS: Array<TerminalLogEntry['level']> = ['debug', 'info', 'warn', 'error'];
const MAX_VISIBLE_ENTRIES = 1_000;

function formatLogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function mergeLogEntry(current: LogEntry[], incoming: LogEntry): LogEntry[] {
  if (!incoming || !Number.isFinite(incoming.id) || typeof incoming.message !== 'string') {
    return current;
  }
  const duplicateIndex = current.findIndex((entry) => entry.id === incoming.id);
  if (duplicateIndex >= 0) {
    if (current[duplicateIndex] === incoming) return current;
    const next = [...current];
    next[duplicateIndex] = incoming;
    return next;
  }
  const next = [...current, incoming];
  return next.length > MAX_VISIBLE_ENTRIES
    ? next.slice(next.length - MAX_VISIBLE_ENTRIES)
    : next;
}

export default function TerminalLogs() {
  const { t } = useI18n();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [query, setQuery] = useState('');
  const [enabledLevels, setEnabledLevels] = useState<Set<LogEntry['level']>>(
    () => new Set(LEVELS),
  );
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [connectionError, setConnectionError] = useState('');
  const [autoFollow, setAutoFollow] = useState(true);
  const terminalBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      controller = new AbortController();
      setConnectionState((current) => current === 'connecting' ? 'connecting' : 'reconnecting');
      void api.streamTerminalLogs({
        limit: 300,
        signal: controller.signal,
        onOpen: () => {
          if (disposed) return;
          setLogs([]);
          setConnectionState('live');
          setConnectionError('');
        },
        onLog: (entry) => {
          if (!disposed) setLogs((current) => mergeLogEntry(current, entry));
        },
      }).then(() => {
        if (disposed) return;
        setConnectionState('reconnecting');
        retryTimer = setTimeout(connect, 1_500);
      }).catch((error: unknown) => {
        if (disposed || controller?.signal.aborted) return;
        setConnectionState('reconnecting');
        setConnectionError(error instanceof Error ? error.message : t('日志连接已断开'));
        retryTimer = setTimeout(connect, 2_500);
      });
    };

    connect();
    return () => {
      disposed = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [t]);

  const filteredLogs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return logs.filter((entry) => {
      if (!enabledLevels.has(entry.level)) return false;
      if (!normalizedQuery) return true;
      return entry.message.toLowerCase().includes(normalizedQuery)
        || entry.source.toLowerCase().includes(normalizedQuery)
        || entry.level.includes(normalizedQuery);
    });
  }, [enabledLevels, logs, query]);

  useEffect(() => {
    if (!autoFollow) return;
    const terminal = terminalBodyRef.current;
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }, [autoFollow, filteredLogs]);

  const toggleLevel = (level: LogEntry['level']) => {
    setEnabledLevels((current) => {
      const next = new Set(current);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const downloadLogs = () => {
    const text = filteredLogs
      .map((entry) => `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}`)
      .join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `metapi-terminal-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const statusLabel = connectionState === 'live'
    ? t('实时连接')
    : connectionState === 'connecting'
      ? t('正在连接')
      : t('正在重连');

  return (
    <div className="terminal-logs-page animate-fade-in">
      <div className="page-header terminal-logs-page-header">
        <div>
          <h2 className="page-title">{t('终端日志')}</h2>
          <p className="page-subtitle">{t('实时查看当前 Metapi 进程的控制台与服务请求日志')}</p>
        </div>
        <div className="page-actions">
          <span className={`terminal-connection-badge is-${connectionState}`}>
            <span className="terminal-connection-dot" />
            {statusLabel}
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => setLogs([])}>
            {t('清空当前视图')}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={downloadLogs}
            disabled={filteredLogs.length === 0}
          >
            {t('下载日志')}
          </button>
        </div>
      </div>

      <div className="terminal-toolbar">
        <label className="terminal-search-field">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('搜索日志内容...')}
            aria-label={t('搜索日志内容')}
          />
        </label>
        <div className="terminal-level-filters" aria-label={t('日志级别筛选')}>
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={`terminal-level-filter level-${level} ${enabledLevels.has(level) ? 'active' : ''}`}
              aria-pressed={enabledLevels.has(level)}
              onClick={() => toggleLevel(level)}
            >
              {level.toUpperCase()}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`terminal-follow-toggle ${autoFollow ? 'active' : ''}`}
          aria-pressed={autoFollow}
          onClick={() => setAutoFollow((current) => !current)}
        >
          <span className="terminal-follow-toggle-track"><span /></span>
          {t('自动跟随')}
        </button>
      </div>

      {connectionError && (
        <div className="terminal-connection-error">
          {connectionError}，{t('正在自动重连')}
        </div>
      )}

      <section className="terminal-window" aria-label={t('终端日志')}>
        <div className="terminal-window-chrome">
          <div className="terminal-window-lights" aria-hidden="true">
            <span className="red" /><span className="yellow" /><span className="green" />
          </div>
          <span className="terminal-window-title">metapi — server</span>
          <span className="terminal-window-count">{filteredLogs.length} / {logs.length}</span>
        </div>
        <div className="terminal-log-body" ref={terminalBodyRef}>
          {filteredLogs.length === 0 ? (
            <div className="terminal-empty">
              <span>&gt;_</span>
              <strong>{logs.length === 0 ? t('等待终端日志...') : t('没有匹配的日志')}</strong>
              <small>{logs.length === 0 ? t('新日志会实时显示在这里') : t('请调整关键词或日志级别')}</small>
            </div>
          ) : filteredLogs.map((entry) => (
            <div className={`terminal-log-line level-${entry.level}`} key={entry.id}>
              <time dateTime={entry.timestamp}>{formatLogTime(entry.timestamp)}</time>
              <span className="terminal-log-level">{entry.level.toUpperCase()}</span>
              <span className="terminal-log-source">{entry.source}</span>
              <pre>{entry.message}</pre>
            </div>
          ))}
        </div>
      </section>
      <p className="terminal-retention-note">
        {t('仅保留当前进程最近 1000 条日志；重启服务后会清空，不会写入数据库。')}
      </p>
    </div>
  );
}
