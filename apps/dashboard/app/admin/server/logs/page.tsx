'use client';

/**
 * Log viewer.
 *
 * Streamed, not polled. A log viewer exists so you can watch the line that
 * explains the outage appear; a five-second poll on a busy service means
 * scrolling back through a wall of text to find it.
 *
 * Lines are held in a bounded ring rather than an ever-growing array. A tail
 * of `nginx` under load produces thousands of lines a minute and the browser
 * tab is not a log archive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, API_URL, session } from '@/lib/api';
import { Button, Panel, Alert, Skeleton, Input } from '@/components/ui';
import { AgentOffline } from '@/components/server-ui';
import type { AgentStatus } from '@/lib/server';

interface LogSource {
  id: string;
  label: string;
  available: boolean;
  via: string;
  detail: string | null;
}

/** Above this the oldest lines are dropped. Roughly a few MB of text. */
const MAX_LINES = 5_000;

const SEVERITY = [
  { id: 'all', label: 'All' },
  { id: 'error', label: 'Errors', pattern: /\b(error|fatal|panic|critical|emerg|alert)\b/i },
  { id: 'warn', label: 'Warnings', pattern: /\b(warn|warning)\b/i },
] as const;

export default function LogsPage() {
  const [source, setSource] = useState<string>('api');
  const [following, setFollowing] = useState(true);
  const [filter, setFilter] = useState('');
  const [severity, setSeverity] = useState<(typeof SEVERITY)[number]['id']>('all');
  const [lines, setLines] = useState<string[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const eventSourceRef = useRef<EventSource | null>(null);

  const agent = useQuery({
    queryKey: ['server-agent'],
    queryFn: () => api<AgentStatus>('/api/v1/admin/server/agent'),
    retry: false,
  });

  const sources = useQuery({
    queryKey: ['log-sources'],
    queryFn: () => api<{ sources: LogSource[] }>('/api/v1/admin/server/logs'),
    retry: false,
    enabled: agent.data?.reachable === true,
  });

  const append = useCallback((chunk: string) => {
    setLines((current) => {
      const incoming = chunk.split('\n').filter((line) => line.length > 0);
      if (incoming.length === 0) return current;
      const next = current.concat(incoming);
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  /* ---- load a backfill, then follow -------------------------------- */

  useEffect(() => {
    let cancelled = false;
    setLines([]);
    setStreamError(null);
    eventSourceRef.current?.close();
    eventSourceRef.current = null;

    void (async () => {
      try {
        const initial = await api<{ lines: string[]; available: boolean; output: string }>(
          `/api/v1/admin/server/logs/${source}?lines=500`,
        );
        if (cancelled) return;
        if (!initial.available) {
          setStreamError(initial.output || 'This log source is not available on this host.');
          return;
        }
        setLines(initial.lines ?? []);
      } catch (error) {
        if (!cancelled) setStreamError((error as Error).message);
        return;
      }

      if (cancelled || !following) return;

      /**
       * EventSource cannot set an Authorization header, and this endpoint is
       * cookie-authenticated for exactly that reason — the access token stays
       * out of the URL and therefore out of the nginx access log.
       */
      const stream = new EventSource(`${API_URL}/api/v1/admin/server/logs/${source}/stream?lines=0`, {
        withCredentials: true,
      });
      eventSourceRef.current = stream;

      stream.addEventListener('line', (event) => {
        append((JSON.parse((event as MessageEvent).data as string) as { data: string }).data);
      });
      stream.addEventListener('error', (event) => {
        const payload = (event as MessageEvent).data;
        if (payload) {
          try {
            setStreamError((JSON.parse(payload as string) as { message: string }).message);
          } catch {
            /* transport-level error; EventSource retries on its own */
          }
        }
      });
    })();

    return () => {
      cancelled = true;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [source, following, append]);

  /* ---- keep the view pinned to the bottom while following ---------- */

  useEffect(() => {
    if (!pinnedRef.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines]);

  const visible = useMemo(() => {
    const severityPattern = SEVERITY.find((entry) => entry.id === severity && 'pattern' in entry);
    const needle = filter.trim().toLowerCase();
    return lines.filter((line) => {
      if (needle && !line.toLowerCase().includes(needle)) return false;
      if (severityPattern && 'pattern' in severityPattern && !severityPattern.pattern.test(line)) return false;
      return true;
    });
  }, [lines, filter, severity]);

  const download = () => {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kairos-${source}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (agent.isLoading) return <Skeleton rows={6} />;
  if (!agent.data?.reachable) {
    return <AgentOffline detail={agent.data?.detail ?? 'unknown'} configured={agent.data?.configured ?? false} />;
  }

  const available = sources.data?.sources.filter((entry) => entry.available) ?? [];
  const unavailable = sources.data?.sources.filter((entry) => !entry.available) ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl text-body">Logs</h1>
        <p className="mt-1 text-sm text-muted">
          Read straight from journald, Docker or the file the service writes — whichever this host actually uses.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {sources.isLoading ? (
          <span className="text-sm text-muted">Finding log sources…</span>
        ) : (
          available.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setSource(entry.id)}
              aria-pressed={source === entry.id}
              className={`rounded border px-2.5 py-1 text-xs transition-colors ${
                source === entry.id
                  ? 'border-signal bg-raised text-body'
                  : 'border-edge bg-transparent text-muted hover:text-body'
              }`}
            >
              {entry.label}
            </button>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter lines…"
          className="max-w-xs"
          aria-label="Filter log lines"
        />
        <div className="inline-flex overflow-hidden rounded border border-edge">
          {SEVERITY.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setSeverity(entry.id)}
              aria-pressed={severity === entry.id}
              className={`px-2.5 py-1.5 text-xs transition-colors ${
                severity === entry.id ? 'bg-raised text-body' : 'text-muted hover:text-body'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setFollowing((value) => !value)}>
          {following ? '⏸ Pause' : '▶ Follow'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setLines([])}>
          Clear
        </Button>
        <Button size="sm" variant="ghost" onClick={download}>
          Download
        </Button>
        <span className="font-mono text-xs text-muted">
          {visible.length.toLocaleString()} of {lines.length.toLocaleString()} lines
          {lines.length >= MAX_LINES ? ' (oldest dropped)' : ''}
        </span>
      </div>

      {streamError ? <Alert>{streamError}</Alert> : null}

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          // Within 40px of the bottom counts as "following"; scrolling up to
          // read something should not be fought by an autoscroll.
          pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
        className="h-[600px] overflow-auto rounded-lg border border-edge bg-ink p-3"
        role="log"
        aria-live="polite"
        aria-label={`${source} log`}
      >
        {visible.length === 0 ? (
          <p className="font-mono text-xs text-muted">
            {lines.length === 0 ? 'No log lines yet.' : 'No lines match the current filter.'}
          </p>
        ) : (
          <ol className="space-y-0.5">
            {visible.map((line, index) => (
              <li
                key={`${index}-${line.slice(0, 24)}`}
                className={`whitespace-pre-wrap break-all font-mono text-xs leading-relaxed ${
                  /\b(error|fatal|panic|critical)\b/i.test(line)
                    ? 'text-coral'
                    : /\b(warn|warning)\b/i.test(line)
                      ? 'text-amber'
                      : 'text-body'
                }`}
              >
                {line}
              </li>
            ))}
          </ol>
        )}
      </div>

      {unavailable.length > 0 ? (
        <Panel title="Not available on this host">
          <ul className="space-y-1">
            {unavailable.map((entry) => (
              <li key={entry.id} className="flex justify-between gap-4 text-xs">
                <span className="text-muted">{entry.label}</span>
                <span className="text-right font-mono text-muted">{entry.detail}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
