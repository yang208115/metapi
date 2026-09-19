import { Writable } from 'node:stream';
import { format } from 'node:util';
import type { ServerResponse } from 'node:http';

export type TerminalLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TerminalLogEntry {
  id: number;
  timestamp: string;
  level: TerminalLogLevel;
  source: 'console' | 'fastify';
  message: string;
}

type TerminalLogListener = (entry: TerminalLogEntry) => void;

const MAX_ENTRIES = 1_000;
const MAX_MESSAGE_LENGTH = 20_000;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const entries: TerminalLogEntry[] = [];
const listeners = new Set<TerminalLogListener>();
let nextEntryId = 1;
let consoleCaptureInstalled = false;

function normalizeMessage(message: string): string {
  const clean = message.replace(ANSI_ESCAPE_PATTERN, '').replace(/\r\n/g, '\n');
  if (clean.length <= MAX_MESSAGE_LENGTH) return clean;
  return `${clean.slice(0, MAX_MESSAGE_LENGTH)}\n... [message truncated]`;
}

function appendTerminalLog(input: Omit<TerminalLogEntry, 'id'>): TerminalLogEntry {
  const entry: TerminalLogEntry = {
    ...input,
    id: nextEntryId++,
    message: normalizeMessage(input.message),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // A disconnected log consumer must not affect the server process.
    }
  }
  return entry;
}

function pinoLevelToTerminalLevel(level: unknown): TerminalLogLevel {
  const numericLevel = Number(level);
  if (numericLevel >= 50) return 'error';
  if (numericLevel >= 40) return 'warn';
  if (numericLevel <= 20) return 'debug';
  return 'info';
}

function formatPinoMessage(payload: Record<string, unknown>, rawLine: string): string {
  const parts: string[] = [];
  if (typeof payload.msg === 'string' && payload.msg.trim()) {
    parts.push(payload.msg.trim());
  }

  const request = payload.req && typeof payload.req === 'object'
    ? payload.req as Record<string, unknown>
    : null;
  if (request) {
    const method = typeof request.method === 'string' ? request.method : '';
    const url = typeof request.url === 'string' ? request.url : '';
    if (method || url) parts.push([method, url].filter(Boolean).join(' '));
  }

  const response = payload.res && typeof payload.res === 'object'
    ? payload.res as Record<string, unknown>
    : null;
  if (response && Number.isFinite(Number(response.statusCode))) {
    parts.push(`status=${Number(response.statusCode)}`);
  }
  if (Number.isFinite(Number(payload.responseTime))) {
    parts.push(`duration=${Number(payload.responseTime).toFixed(1)}ms`);
  }

  const error = payload.err && typeof payload.err === 'object'
    ? payload.err as Record<string, unknown>
    : null;
  if (error) {
    const errorText = typeof error.stack === 'string'
      ? error.stack
      : typeof error.message === 'string'
        ? error.message
        : JSON.stringify(error);
    if (errorText) parts.push(errorText);
  }

  return parts.length > 0 ? parts.join(' · ') : rawLine;
}

function capturePinoLine(rawLine: string): void {
  const line = rawLine.trim();
  if (!line) return;
  try {
    const payload = JSON.parse(line) as Record<string, unknown>;
    const time = typeof payload.time === 'number' || typeof payload.time === 'string'
      ? new Date(payload.time)
      : new Date();
    appendTerminalLog({
      timestamp: Number.isNaN(time.getTime()) ? new Date().toISOString() : time.toISOString(),
      level: pinoLevelToTerminalLevel(payload.level),
      source: 'fastify',
      message: formatPinoMessage(payload, line),
    });
  } catch {
    appendTerminalLog({
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'fastify',
      message: line,
    });
  }
}

export function installConsoleLogCapture(): void {
  if (consoleCaptureInstalled) return;
  consoleCaptureInstalled = true;

  const levels: Array<keyof Pick<Console, 'debug' | 'info' | 'log' | 'warn' | 'error'>> = [
    'debug',
    'info',
    'log',
    'warn',
    'error',
  ];
  for (const method of levels) {
    const original = console[method].bind(console);
    const level: TerminalLogLevel = method === 'log' ? 'info' : method;
    console[method] = ((...args: unknown[]) => {
      appendTerminalLog({
        timestamp: new Date().toISOString(),
        level,
        source: 'console',
        message: format(...args),
      });
      original(...args);
    }) as Console[typeof method];
  }
}

export function createTerminalLogStream(): Writable {
  let pending = '';
  return new Writable({
    write(chunk, _encoding, callback) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      process.stdout.write(chunk);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) capturePinoLine(line);
      callback();
    },
    final(callback) {
      if (pending.trim()) capturePinoLine(pending);
      pending = '';
      callback();
    },
  });
}

function resolveHttpErrorMessage(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const directMessage = typeof record.message === 'string' ? record.message : '';
    if (directMessage) return directMessage;
    if (record.error && typeof record.error === 'object') {
      const error = record.error as Record<string, unknown>;
      if (typeof error.message === 'string' && error.message) return error.message;
    }
  }

  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return '';
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
  try {
    return resolveHttpErrorMessage(JSON.parse(text));
  } catch {
    return text.trim().slice(0, 500);
  }
}

export function recordTerminalHttpError(input: {
  method: string;
  url: string;
  statusCode: number;
  payload: unknown;
}): void {
  const message = resolveHttpErrorMessage(input.payload);
  const suffix = message ? `: ${message}` : '';
  console.warn(`[http] ${input.method} ${input.url} -> ${input.statusCode}${suffix}`);
}

export function subscribeToTerminalLogs(
  limit: number,
  listener: TerminalLogListener,
): { snapshot: TerminalLogEntry[]; unsubscribe: () => void } {
  listeners.add(listener);
  const safeLimit = Math.max(1, Math.min(MAX_ENTRIES, Math.trunc(limit) || 300));
  return {
    snapshot: entries.slice(-safeLimit),
    unsubscribe: () => listeners.delete(listener),
  };
}

function writeSseEvent(response: ServerResponse, entry: TerminalLogEntry): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
}

export function openTerminalLogStream(
  response: ServerResponse,
  limit: number,
): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();

  const subscription = subscribeToTerminalLogs(limit, (entry) => {
    writeSseEvent(response, entry);
  });
  for (const entry of subscription.snapshot) writeSseEvent(response, entry);

  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) {
      response.write(': heartbeat\n\n');
    }
  }, 15_000);
  heartbeat.unref?.();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    subscription.unsubscribe();
  };
  response.once('close', cleanup);
}
