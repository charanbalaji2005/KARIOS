'use client';

/**
 * Shared pieces for the server console.
 *
 * The one that matters is `DangerDialog`. Every operation the agent marks
 * dangerous routes through it, and it makes the operator type the phrase the
 * agent itself will check — so the words on screen are the words the server
 * requires, rather than a copy that can drift out of step with it.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Input } from './ui';

/* ---------------------------------------------------------------- state */

export type HostState = 'running' | 'stopped' | 'failed' | 'not_installed' | 'unknown' | 'active' | 'inactive';

const STATE_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  running: { dot: 'bg-mint', text: 'text-mint', label: 'RUNNING' },
  active: { dot: 'bg-mint', text: 'text-mint', label: 'ACTIVE' },
  stopped: { dot: 'bg-muted', text: 'text-muted', label: 'STOPPED' },
  inactive: { dot: 'bg-muted', text: 'text-muted', label: 'INACTIVE' },
  failed: { dot: 'bg-coral', text: 'text-coral', label: 'FAILED' },
  not_installed: { dot: 'bg-edge', text: 'text-muted', label: 'NOT INSTALLED' },
  unknown: { dot: 'bg-amber', text: 'text-amber', label: 'UNKNOWN' },
};

export function StateBadge({ state, label }: { state: string; label?: string }) {
  const style = STATE_STYLES[state] ?? STATE_STYLES['unknown']!;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
      <span className={`font-mono text-xs ${style.text}`}>{label ?? style.label}</span>
    </span>
  );
}

/* ---------------------------------------------------------------- meter */

export function Meter({ label, percent, detail }: { label: string; percent: number; detail?: string }) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  const bar = clamped >= 90 ? 'bg-coral' : clamped >= 75 ? 'bg-amber' : 'bg-signal';
  const text = clamped >= 90 ? 'text-coral' : clamped >= 75 ? 'text-amber' : 'text-mint';
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
        <span className={`font-mono text-sm ${text}`}>{clamped.toFixed(1)}%</span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised"
        role="meter"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={`h-full ${bar} transition-[width] duration-500`} style={{ width: `${clamped}%` }} />
      </div>
      {detail ? <p className="mt-1.5 font-mono text-xs text-muted">{detail}</p> : null}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'text-coral' : tone === 'warn' ? 'text-amber' : 'text-body';
  return (
    <div className="rounded-lg border border-edge bg-raised px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 font-mono text-lg ${color}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------- terminal */

/**
 * Monospaced output block for operation results.
 *
 * Not an xterm instance — that would be a lot of machinery for text that never
 * needs a cursor. ANSI is stripped rather than rendered here, because the
 * alternative is escape sequences printed literally, which looks broken.
 */
export function Output({ text, className = '' }: { text: string; className?: string }) {
  if (!text) return null;
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  return (
    <pre
      className={`max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-edge bg-ink px-3 py-2 font-mono text-xs leading-relaxed text-body ${className}`}
    >
      {clean}
    </pre>
  );
}

/* --------------------------------------------------------- danger modal */

export interface DangerAction {
  title: string;
  /** What this will do, in plain words, including what breaks. */
  description: ReactNode;
  /** The exact phrase the agent will check. Shown, and required. */
  confirmPhrase: string;
  actionLabel: string;
}

/**
 * Typed-confirmation dialog.
 *
 * The phrase is displayed and must be typed exactly. That is deliberately more
 * friction than a second click: a click can be muscle memory, and the whole
 * purpose is to interrupt muscle memory before somebody restarts the database
 * they meant to inspect.
 */
export function DangerDialog({
  action,
  open,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  action: DangerAction | null;
  open: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (phrase: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTyped('');
      // Focus after paint, or the dialog animates in and steals it back.
      const timer = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [open, action?.confirmPhrase]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open || !action) return null;

  const matches = typed === action.confirmPhrase;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="danger-title"
    >
      <div className="w-full max-w-lg rounded-lg border border-[#4A2B2B] bg-panel shadow-2xl">
        <header className="border-b border-edge px-5 py-4">
          <p className="font-mono text-xs uppercase tracking-widest text-coral">Warning</p>
          <h2 id="danger-title" className="mt-1 text-base text-body">
            {action.title}
          </h2>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div className="text-sm leading-relaxed text-muted">{action.description}</div>

          <div>
            <label className="block text-sm text-body" htmlFor="danger-confirm">
              Type <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-coral">{action.confirmPhrase}</code> to
              continue
            </label>
            <Input
              id="danger-confirm"
              ref={inputRef}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && matches && !busy) onConfirm(typed);
              }}
              autoComplete="off"
              spellCheck={false}
              className="mt-2 font-mono"
              aria-invalid={typed.length > 0 && !matches}
            />
          </div>

          {error ? (
            <p role="alert" className="rounded border border-[#4A2B2B] bg-[#241A1A] px-3 py-2 text-sm text-coral">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-edge px-5 py-3">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!matches || busy} onClick={() => onConfirm(typed)}>
            {busy ? 'Working…' : action.actionLabel}
          </Button>
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ agent gate */

/**
 * What every server page shows when there is no agent to talk to.
 *
 * Specific instructions, not "something went wrong". On this product the
 * commonest cause is that the reader is running `pnpm dev` on a laptop that
 * was never provisioned, and the right response is to say so.
 */
export function AgentOffline({ detail, configured }: { detail: string; configured: boolean }) {
  return (
    <div className="rounded-lg border border-edge bg-panel p-6">
      <div className="flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-coral" aria-hidden />
        <h2 className="text-sm font-medium text-body">Server agent unreachable</h2>
      </div>

      <p className="mt-3 text-sm text-muted">{detail}</p>

      {configured ? (
        <div className="mt-4 space-y-2 text-sm text-muted">
          <p>The credential is configured, so this is the agent not running rather than KAIROS not being set up:</p>
          <pre className="rounded border border-edge bg-ink px-3 py-2 font-mono text-xs text-body">
            sudo systemctl status kairos-server-agent{'\n'}sudo systemctl start kairos-server-agent{'\n'}sudo journalctl -u
            kairos-server-agent -n 50
          </pre>
        </div>
      ) : (
        <div className="mt-4 space-y-2 text-sm text-muted">
          <p>
            This installation has no agent credential, so it is not set up to manage a host. That is the normal state for
            a development checkout — the server console only works on the Ubuntu machine KAIROS was installed on.
          </p>
          <pre className="rounded border border-edge bg-ink px-3 py-2 font-mono text-xs text-body">
            sudo ./scripts/install-server.sh
          </pre>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ formatting */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.round(seconds)}s`;
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const delta = (Date.now() - new Date(iso).getTime()) / 1000;
  if (delta < 60) return 'just now';
  return `${formatDuration(delta)} ago`;
}
