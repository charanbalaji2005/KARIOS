'use client';

/**
 * Server terminal.
 *
 * KAIROS Shell is the default and needs no ceremony: it runs the same
 * allowlisted operations the buttons elsewhere in this console run, so there
 * is nothing it can do that the dashboard cannot.
 *
 * The Ubuntu Terminal is a different thing and is treated as one. It is off
 * until deliberately enabled, enabling it needs a recent sign-in and a second
 * factor, and the grant expires on its own — because the realistic failure is
 * not an attacker, it is somebody turning it on during an incident and never
 * turning it off.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Button, Input, Panel, Alert, Field } from '@/components/ui';
import { AgentOffline, formatDuration } from '@/components/server-ui';
import { ServerTerminal, type TerminalHandle, type TerminalMode, type ConnectionState } from '@/components/terminal';
import type { AgentStatus } from '@/lib/server';

interface GrantInfo {
  active: boolean;
  grant: { id: string; grantedAt: string; expiresAt: string; reason: string; mfaVerified: boolean } | null;
  ttlMinutes: number;
  requirements: {
    recentAuth: { satisfied: boolean; lastAuthAt: string | null; withinMinutes: number };
    mfa: { enrolled: boolean; required: boolean };
  };
}

const STATE_LABEL: Record<ConnectionState, { text: string; dot: string; color: string }> = {
  connecting: { text: 'CONNECTING', dot: 'bg-amber', color: 'text-amber' },
  connected: { text: 'CONNECTED', dot: 'bg-mint', color: 'text-mint' },
  closed: { text: 'DISCONNECTED', dot: 'bg-muted', color: 'text-muted' },
  error: { text: 'ERROR', dot: 'bg-coral', color: 'text-coral' },
};

export default function TerminalPage() {
  const queryClient = useQueryClient();
  const terminalRef = useRef<TerminalHandle>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<TerminalMode>('kairos_shell');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [connectionDetail, setConnectionDetail] = useState<string | undefined>();
  const [fullscreen, setFullscreen] = useState(false);
  const [showEnable, setShowEnable] = useState(false);
  const [confirmPrompt, setConfirmPrompt] = useState<{ line: string } | null>(null);
  const [confirmPhrase, setConfirmPhrase] = useState('');

  const agent = useQuery({
    queryKey: ['server-agent'],
    queryFn: () => api<AgentStatus>('/api/v1/admin/server/agent'),
    retry: false,
  });

  const grant = useQuery({
    queryKey: ['terminal-grant'],
    queryFn: () => api<GrantInfo>('/api/v1/admin/server/terminal/grant'),
    // The grant expires on a timer, so the badge has to notice on its own.
    refetchInterval: 30_000,
    retry: false,
  });

  /**
   * A ticket is redeemed once, so every connection gets a fresh one. The
   * terminal component calls this on connect and on reconnect.
   */
  const requestTicket = useCallback(async () => {
    const result = await api<{ ticket: string }>('/api/v1/admin/server/terminal/ticket', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
    return result.ticket;
  }, [mode]);

  const onState = useCallback((state: ConnectionState, detail?: string) => {
    setConnection(state);
    setConnectionDetail(detail);
  }, []);

  const onConfirmRequired = useCallback((info: { line: string }) => {
    setConfirmPhrase('');
    setConfirmPrompt({ line: info.line });
  }, []);

  /* ---- Escape leaves fullscreen ------------------------------------ */
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const downloadTranscript = () => {
    const text = terminalRef.current?.transcript() ?? '';
    // Strip ANSI so the saved file is readable in a text editor, which is the
    // only reason anyone downloads it.
    const clean = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    const blob = new Blob([clean], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kairos-terminal-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (agent.isLoading) return <p className="text-sm text-muted">Checking the server agent…</p>;
  if (!agent.data?.reachable) {
    return <AgentOffline detail={agent.data?.detail ?? 'unknown'} configured={agent.data?.configured ?? false} />;
  }

  const grantActive = grant.data?.active ?? false;
  const expiresInMs = grant.data?.grant ? new Date(grant.data.grant.expiresAt).getTime() - Date.now() : 0;
  const state = STATE_LABEL[connection];

  const terminalPanel = (
    <div
      ref={wrapperRef}
      className={
        fullscreen
          ? 'fixed inset-0 z-40 flex flex-col bg-ink'
          : 'flex flex-col overflow-hidden rounded-lg border border-edge bg-ink'
      }
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge bg-panel px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            {mode === 'kairos_shell' ? 'KAIROS Shell' : 'Ubuntu Terminal'}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${state.dot}`} aria-hidden />
            <span className={`font-mono text-xs ${state.color}`}>{state.text}</span>
          </span>
          {connectionDetail ? <span className="font-mono text-xs text-muted">{connectionDetail}</span> : null}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => terminalRef.current?.reconnect()}>
            Reconnect
          </Button>
          <Button size="sm" variant="ghost" onClick={() => terminalRef.current?.clear()}>
            Clear
          </Button>
          <Button size="sm" variant="ghost" onClick={downloadTranscript}>
            Download log
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFullscreen((value) => !value)}>
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </Button>
        </div>
      </header>

      <div className={fullscreen ? 'min-h-0 flex-1 p-2' : 'h-[540px] p-2'}>
        <ServerTerminal
          key={mode}
          ref={terminalRef}
          mode={mode}
          requestTicket={requestTicket}
          onState={onState}
          onConfirmRequired={onConfirmRequired}
        />
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {!fullscreen ? (
        <>
          <header>
            <h1 className="text-xl text-body">Terminal</h1>
            <p className="mt-1 text-sm text-muted">
              Commands here run on the Ubuntu host through the server agent. Every one of them is recorded.
            </p>
          </header>

          {/* ---- mode switch ------------------------------------- */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex overflow-hidden rounded border border-edge" role="group" aria-label="Terminal mode">
              <button
                type="button"
                onClick={() => setMode('kairos_shell')}
                aria-pressed={mode === 'kairos_shell'}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  mode === 'kairos_shell' ? 'bg-raised text-body' : 'bg-transparent text-muted hover:text-body'
                }`}
              >
                KAIROS Shell
              </button>
              <button
                type="button"
                onClick={() => (grantActive ? setMode('ubuntu_terminal') : setShowEnable(true))}
                aria-pressed={mode === 'ubuntu_terminal'}
                className={`border-l border-edge px-3 py-1.5 text-sm transition-colors ${
                  mode === 'ubuntu_terminal' ? 'bg-raised text-body' : 'bg-transparent text-muted hover:text-body'
                }`}
              >
                Ubuntu Terminal {grantActive ? '' : '🔒'}
              </button>
            </div>

            {grantActive && grant.data?.grant ? (
              <span className="font-mono text-xs text-amber">
                root shell enabled · expires in {formatDuration(Math.max(0, expiresInMs / 1000))}
              </span>
            ) : null}

            {grantActive ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await api('/api/v1/admin/server/terminal/grant', { method: 'DELETE' });
                  setMode('kairos_shell');
                  void queryClient.invalidateQueries({ queryKey: ['terminal-grant'] });
                }}
              >
                Disable now
              </Button>
            ) : null}
          </div>

          {mode === 'ubuntu_terminal' ? (
            <Alert>
              This is a real root shell on {agent.data.health?.dataRoot ? 'this host' : 'the host'}. The session is
              recorded (who, when, from where) but individual keystrokes are not — capturing those would capture
              passwords typed into sudo. It closes itself when idle.
            </Alert>
          ) : null}
        </>
      ) : null}

      {terminalPanel}

      {!fullscreen ? (
        <Panel title="What this shell can do">
          <p className="text-sm text-muted">
            KAIROS Shell is not bash. Each line is parsed into one of the operations the agent allows and run through the
            same allowlist as the buttons elsewhere in this console — so there is no command you can type here that could
            not also be clicked.
          </p>
          <div className="mt-4 grid gap-1.5 font-mono text-xs text-muted sm:grid-cols-2">
            <code>kairos status</code>
            <code>kairos doctor</code>
            <code>kairos services</code>
            <code>kairos service restart postgres</code>
            <code>kairos database status</code>
            <code>kairos redis status</code>
            <code>kairos storage status</code>
            <code>kairos firewall status</code>
            <code>kairos backup list</code>
            <code>kairos backup create</code>
            <code>kairos logs api 200</code>
            <code>kairos network ports</code>
          </div>
          <p className="mt-4 text-sm text-muted">
            Type <code className="font-mono text-body">help</code> for the full grammar, or{' '}
            <code className="font-mono text-body">operations</code> to print the entire allowlist.
          </p>
        </Panel>
      ) : null}

      {/* ---- enable Ubuntu Terminal ---------------------------------- */}
      {showEnable ? (
        <EnableUbuntuTerminal
          info={grant.data ?? null}
          onCancel={() => setShowEnable(false)}
          onEnabled={() => {
            setShowEnable(false);
            setMode('ubuntu_terminal');
            void queryClient.invalidateQueries({ queryKey: ['terminal-grant'] });
          }}
        />
      ) : null}

      {/* ---- confirmation for a dangerous shell command -------------- */}
      {confirmPrompt ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg rounded-lg border border-[#4A2B2B] bg-panel">
            <header className="border-b border-edge px-5 py-4">
              <p className="font-mono text-xs uppercase tracking-widest text-coral">Confirmation required</p>
              <h2 className="mt-1 text-base text-body">
                <code className="font-mono">{confirmPrompt.line}</code>
              </h2>
            </header>
            <div className="space-y-4 px-5 py-4">
              <p className="text-sm text-muted">
                The agent marked this operation dangerous and will not run it without the exact phrase it asked for. It
                is printed in the terminal output above.
              </p>
              <Field label="Confirmation phrase">
                <Input
                  autoFocus
                  value={confirmPhrase}
                  onChange={(event) => setConfirmPhrase(event.target.value)}
                  className="font-mono"
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
            </div>
            <footer className="flex justify-end gap-2 border-t border-edge px-5 py-3">
              <Button variant="ghost" onClick={() => setConfirmPrompt(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={confirmPhrase.trim().length === 0}
                onClick={() => {
                  terminalRef.current?.sendConfirmed(confirmPrompt.line, confirmPhrase.trim());
                  setConfirmPrompt(null);
                }}
              >
                Run it
              </Button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ==================================================================== */

/**
 * The enable dialog.
 *
 * It states the requirements before asking for anything, so somebody who
 * cannot satisfy them finds out now rather than after typing a reason and a
 * TOTP code.
 */
function EnableUbuntuTerminal({
  info,
  onCancel,
  onEnabled,
}: {
  info: GrantInfo | null;
  onCancel: () => void;
  onEnabled: () => void;
}) {
  const [reason, setReason] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsMfa = info?.requirements.mfa.required ?? false;
  const recentAuth = info?.requirements.recentAuth;
  const phrase = 'ENABLE UBUNTU TERMINAL';
  const ready = reason.trim().length >= 4 && confirm === phrase && (!needsMfa || mfaCode.trim().length >= 6);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/admin/server/terminal/grant', {
        method: 'POST',
        body: JSON.stringify({
          reason: reason.trim(),
          confirm: phrase,
          ...(needsMfa ? { mfaCode: mfaCode.trim() } : {}),
        }),
      });
      onEnabled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not enable the terminal.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/80 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-lg border border-[#4A2B2B] bg-panel">
        <header className="border-b border-edge px-5 py-4">
          <p className="font-mono text-xs uppercase tracking-widest text-coral">High-risk</p>
          <h2 className="mt-1 text-base text-body">Enable the Ubuntu Terminal</h2>
        </header>

        <div className="space-y-4 px-5 py-4">
          <p className="text-sm leading-relaxed text-muted">
            This opens a real root shell on the host — the machine PostgreSQL, your project files and your backups live
            on. It is not restricted to KAIROS operations and nothing in the allowlist applies to it.
          </p>

          <ul className="space-y-1.5 text-sm">
            <li className={recentAuth?.satisfied ? 'text-mint' : 'text-coral'}>
              {recentAuth?.satisfied ? '✓' : '✕'} Signed in within the last {recentAuth?.withinMinutes ?? 15} minutes
              {recentAuth?.satisfied ? '' : ' — sign out and back in first'}
            </li>
            <li className="text-muted">
              {needsMfa ? '• A code from your authenticator is required' : '• No second factor is enrolled on this account'}
            </li>
            <li className="text-muted">• The grant expires after {info?.ttlMinutes ?? 30} minutes on its own</li>
            <li className="text-muted">• The session is recorded; keystrokes are not</li>
          </ul>

          <Field label="Why are you enabling it?" hint="Recorded in the audit log alongside the grant.">
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Investigating why nginx will not start"
              maxLength={200}
            />
          </Field>

          {needsMfa ? (
            <Field label="Authenticator code">
              <Input
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
                placeholder="000000"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="font-mono"
              />
            </Field>
          ) : null}

          <Field label={`Type ${phrase} to continue`}>
            <Input
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>

          {error ? <Alert>{error}</Alert> : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-edge px-5 py-3">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!ready || busy} onClick={submit}>
            {busy ? 'Enabling…' : 'Enable for ' + (info?.ttlMinutes ?? 30) + ' minutes'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
