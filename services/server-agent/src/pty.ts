/**
 * The Ubuntu Terminal — a real PTY on the host.
 *
 * This is the one place in the agent that runs a shell, and it is fenced off
 * accordingly: the API only opens one of these after checking a live, typed,
 * time-boxed grant, and the session here expires on its own whatever the API
 * believes. Two independent clocks, because "the browser closed the tab" is
 * not a security control.
 *
 * `node-pty` is the right tool and is an optional dependency, because it needs
 * a compiler and a laptop that cannot build it should still get a working
 * agent. The fallback uses util-linux `script`, which allocates a real PTY —
 * colours, job control and interactive programs all work; only window resizing
 * does not, and the session says so rather than silently misbehaving.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { log } from './log.js';

export type PtyBackend = 'node-pty' | 'script';

export interface PtySession {
  id: string;
  backend: PtyBackend;
  startedAt: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (code: number) => void): void;
  /** Whether this backend can act on a resize. */
  readonly resizable: boolean;
}

/** A login shell, chosen from a fixed list rather than from $SHELL. */
function resolveShell(): string {
  const candidates = ['/bin/bash', '/usr/bin/bash', '/bin/sh'];
  const shell = candidates.find((candidate) => existsSync(candidate));
  if (!shell) throw new Error('No shell is available on this host.');
  return shell;
}

/**
 * The environment the shell starts in.
 *
 * The agent's own environment holds the agent token and the database URL.
 * Handing those to an interactive shell would mean the Ubuntu Terminal is a
 * way to read the credential that protects the Ubuntu Terminal, so the
 * environment is built from scratch.
 */
function shellEnv(): Record<string, string> {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/root',
    USER: 'root',
    LOGNAME: 'root',
    SHELL: resolveShell(),
    TERM: 'xterm-256color',
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    // So an operator can tell at a glance that this shell came from the panel,
    // and so shell history and motd scripts can behave differently if they care.
    KAIROS_TERMINAL: '1',
    PS1: '\\[\\e[38;5;141m\\]kairos\\[\\e[0m\\]:\\w\\$ ',
  };
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): {
    onData(listener: (data: string) => void): void;
    onExit(listener: (event: { exitCode: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  };
}

let nodePty: NodePtyModule | null | undefined;

async function loadNodePty(): Promise<NodePtyModule | null> {
  if (nodePty !== undefined) return nodePty;
  try {
    // Optional dependency, so the import is deliberately dynamic and its
    // failure is a supported outcome rather than a crash. The specifier is a
    // variable so the compiler does not try to resolve a module that is not
    // installed on the machine doing the build.
    const specifier = 'node-pty';
    nodePty = (await import(specifier)) as unknown as NodePtyModule;
    log.info('PTY backend: node-pty');
  } catch {
    nodePty = null;
    log.info('PTY backend: script (node-pty is not installed; terminal resize will not be applied)');
  }
  return nodePty;
}

export interface OpenPtyOptions {
  cols: number;
  rows: number;
  cwd?: string;
}

export async function openPty(options: OpenPtyOptions): Promise<PtySession> {
  const shell = resolveShell();
  const cwd = options.cwd ?? '/root';
  const id = randomUUID();
  const startedAt = Date.now();

  const dataListeners: ((data: string) => void)[] = [];
  const exitListeners: ((code: number) => void)[] = [];
  const emitData = (data: string) => {
    for (const listener of dataListeners) listener(data);
  };
  const emitExit = (code: number) => {
    for (const listener of exitListeners) listener(code);
  };

  const pty = await loadNodePty();

  if (pty) {
    const child = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd,
      env: shellEnv(),
    });

    child.onData(emitData);
    child.onExit(({ exitCode }) => emitExit(exitCode));

    return {
      id,
      backend: 'node-pty',
      startedAt,
      resizable: true,
      write: (data) => child.write(data),
      resize: (cols, rows) => child.resize(Math.max(1, cols), Math.max(1, rows)),
      kill: (signal) => child.kill(signal),
      onData: (listener) => dataListeners.push(listener),
      onExit: (listener) => exitListeners.push(listener),
    };
  }

  /* ---- fallback: util-linux `script` ------------------------------- */

  if (!existsSync('/usr/bin/script') && !existsSync('/bin/script')) {
    throw new Error(
      'No PTY backend available: node-pty is not installed and util-linux `script` is missing. ' +
        'Install one with: apt-get install util-linux',
    );
  }

  const scriptBinary = existsSync('/usr/bin/script') ? '/usr/bin/script' : '/bin/script';

  // -q quiet, -f flush after every write (so output is not buffered until the
  // command finishes), -c the command to run, /dev/null so no typescript file
  // is written. The shell string here is a constant; nothing from the request
  // reaches it.
  const child: ChildProcess = spawn(scriptBinary, ['-qfc', `${shell} -l`, '/dev/null'], {
    shell: false,
    cwd,
    env: { ...shellEnv(), COLUMNS: String(options.cols), LINES: String(options.rows) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => emitData(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => emitData(chunk.toString('utf8')));
  child.on('close', (code) => emitExit(code ?? -1));
  child.on('error', (error) => {
    emitData(`\r\n[agent] failed to start a terminal: ${error.message}\r\n`);
    emitExit(-1);
  });

  return {
    id,
    backend: 'script',
    startedAt,
    resizable: false,
    write: (data) => child.stdin?.write(data),
    // Nothing to do: `script` does not forward SIGWINCH to its child, so the
    // honest behaviour is to ignore it rather than pretend.
    resize: () => undefined,
    kill: (signal = 'SIGTERM') => child.kill(signal),
    onData: (listener) => dataListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
  };
}

/**
 * Wrap a session with the two timers that end it regardless of what the caller
 * does: an idle timeout, and a hard ceiling on total lifetime.
 */
export function superviseSession(
  session: PtySession,
  onClose: (reason: string) => void,
): { touch(): void; stop(): void } {
  let lastActivity = Date.now();
  let closed = false;

  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    session.kill('SIGHUP');
    onClose(reason);
  };

  const timer = setInterval(() => {
    const now = Date.now();
    if (now - lastActivity > config.ptyIdleTimeoutMs) {
      finish(`idle for more than ${Math.round(config.ptyIdleTimeoutMs / 60_000)} minutes`);
      return;
    }
    if (now - session.startedAt > config.ptyMaxLifetimeMs) {
      finish(`reached the ${Math.round(config.ptyMaxLifetimeMs / 60_000)} minute session limit`);
    }
  }, 15_000);
  timer.unref();

  session.onExit(() => finish('the shell exited'));

  return {
    touch: () => {
      lastActivity = Date.now();
    },
    stop: () => finish('closed by the operator'),
  };
}
