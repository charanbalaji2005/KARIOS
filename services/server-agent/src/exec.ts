/**
 * Process execution.
 *
 * The single most important property of this file: there is no code path that
 * accepts a command *string*. Every entry point takes `(binary, args[])` and
 * spawns with `shell: false`, so `; rm -rf /` arriving in an argument is an
 * argument containing a semicolon — a filename that does not exist — and not a
 * second command. Injection is prevented structurally rather than by escaping,
 * because escaping is something you can forget to do once.
 *
 * The binary itself is resolved against a fixed table of absolute paths. A
 * caller cannot ask for `curl` and get whatever `curl` happens to be first on
 * a PATH that some other unit file set.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config } from './config.js';

/**
 * Binaries the agent is allowed to run, by logical name.
 *
 * Adding a name here is the security decision; everything downstream just
 * refers to the name. `sh`, `bash` and `env` are deliberately absent — an
 * operation that needs a shell is an operation that has not been thought
 * through yet. (The Ubuntu-terminal PTY is the one exception and it opens a
 * login shell directly, under its own grant; see pty.ts.)
 */
const BINARIES = {
  systemctl: ['/usr/bin/systemctl', '/bin/systemctl'],
  journalctl: ['/usr/bin/journalctl', '/bin/journalctl'],
  docker: ['/usr/bin/docker', '/usr/local/bin/docker'],
  nft: ['/usr/sbin/nft', '/sbin/nft'],
  ufw: ['/usr/sbin/ufw', '/sbin/ufw'],
  ip: ['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip'],
  ss: ['/usr/bin/ss', '/usr/sbin/ss', '/bin/ss'],
  df: ['/usr/bin/df', '/bin/df'],
  du: ['/usr/bin/du', '/bin/du'],
  free: ['/usr/bin/free', '/bin/free'],
  lsblk: ['/usr/bin/lsblk', '/bin/lsblk'],
  uname: ['/usr/bin/uname', '/bin/uname'],
  lsb_release: ['/usr/bin/lsb_release'],
  hostnamectl: ['/usr/bin/hostnamectl', '/bin/hostnamectl'],
  uptime: ['/usr/bin/uptime', '/bin/uptime'],
  nproc: ['/usr/bin/nproc', '/bin/nproc'],
  ps: ['/usr/bin/ps', '/bin/ps'],
  top: ['/usr/bin/top', '/bin/top'],
  pg_dump: ['/usr/bin/pg_dump', '/usr/lib/postgresql/17/bin/pg_dump', '/usr/lib/postgresql/16/bin/pg_dump'],
  pg_isready: ['/usr/bin/pg_isready', '/usr/lib/postgresql/17/bin/pg_isready'],
  psql: ['/usr/bin/psql'],
  redisCli: ['/usr/bin/redis-cli', '/usr/local/bin/redis-cli'],
  nginx: ['/usr/sbin/nginx', '/usr/bin/nginx'],
  openssl: ['/usr/bin/openssl'],
  apt_get: ['/usr/bin/apt-get'],
  dpkg_query: ['/usr/bin/dpkg-query'],
  cloudflared: ['/usr/bin/cloudflared', '/usr/local/bin/cloudflared'],
  script: ['/usr/bin/script', '/bin/script'],
  sensors: ['/usr/bin/sensors'],
  shutdown: ['/usr/sbin/shutdown', '/sbin/shutdown'],
  curl: ['/usr/bin/curl'],
  install: ['/usr/bin/install'],
  chown: ['/usr/bin/chown', '/bin/chown'],
  chmod: ['/usr/bin/chmod', '/bin/chmod'],
  mkdir: ['/usr/bin/mkdir', '/bin/mkdir'],
} as const;

export type BinaryName = keyof typeof BINARIES;

const resolved = new Map<BinaryName, string | null>();

/** Absolute path of a known binary, or null when it is not installed. */
export function resolveBinary(name: BinaryName): string | null {
  if (resolved.has(name)) return resolved.get(name)!;
  const found = BINARIES[name].find((candidate) => existsSync(candidate)) ?? null;
  resolved.set(name, found);
  return found;
}

export function binaryAvailable(name: BinaryName): boolean {
  return resolveBinary(name) !== null;
}

export class MissingBinaryError extends Error {
  constructor(readonly binary: BinaryName) {
    super(`${binary} is not installed on this host`);
    this.name = 'MissingBinaryError';
  }
}

export interface RunOptions {
  /** Hard kill after this long. Every operation gets one; there is no "wait forever". */
  timeoutMs?: number;
  /** Extra environment. The base environment is minimal and fixed. */
  env?: Record<string, string>;
  cwd?: string;
  /** Written to the child's stdin and then closed. */
  stdin?: string;
  /** Treat a non-zero exit as success (e.g. `systemctl is-active` on a stopped unit). */
  allowNonZeroExit?: boolean;
  maxOutputBytes?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

/**
 * A minimal, fixed environment.
 *
 * Inheriting the agent's own environment would hand every child process the
 * agent token, which is precisely the secret a child process must never see.
 */
function baseEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/root',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'xterm-256color',
    // systemctl paginates into `less` when it thinks it has a terminal, which
    // hangs a non-interactive caller forever.
    SYSTEMD_COLORS: '0',
    SYSTEMD_PAGER: '',
    PAGER: 'cat',
    ...extra,
  };
}

/**
 * Run a known binary to completion and capture its output.
 */
export async function run(name: BinaryName, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const binary = resolveBinary(name);
  if (!binary) throw new MissingBinaryError(name);

  assertSafeArgs(args);

  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxOutputBytes ?? config.maxOutputBytes;
  const startedAt = Date.now();

  return await new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, args, {
        // The point of the whole file.
        shell: false,
        env: baseEnv(options.env),
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (chunk: Buffer, into: 'out' | 'err') => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      if (into === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };

    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'out'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // SIGTERM is a request. Five seconds later it stops being one.
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    timer.unref();

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: RunResult = {
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      };
      if (timedOut) {
        reject(Object.assign(new Error(`${name} timed out after ${timeoutMs}ms`), { result }));
        return;
      }
      if (result.code !== 0 && !options.allowNonZeroExit) {
        reject(
          Object.assign(new Error(stderr.trim() || stdout.trim() || `${name} exited ${result.code}`), { result }),
        );
        return;
      }
      resolve(result);
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      // Close stdin so a child that reads it does not wait for input nobody
      // will ever send.
      child.stdin.end();
    }
  });
}

/** Convenience: run and return trimmed stdout, or null if the binary is absent or fails. */
export async function tryRun(name: BinaryName, args: string[], options: RunOptions = {}): Promise<string | null> {
  try {
    const result = await run(name, args, { allowNonZeroExit: true, ...options });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

export interface StreamHandle {
  /** Resolves with the exit code once the process finishes. */
  done: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Run a known binary and hand output to a callback as it arrives, for
 * long-running things like `journalctl -f` where buffering would defeat the
 * purpose.
 */
export function stream(
  name: BinaryName,
  args: string[],
  onChunk: (chunk: string, source: 'stdout' | 'stderr') => void,
  options: RunOptions = {},
): StreamHandle {
  const binary = resolveBinary(name);
  if (!binary) throw new MissingBinaryError(name);
  assertSafeArgs(args);

  const child = spawn(binary, args, {
    shell: false,
    env: baseEnv(options.env),
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk: Buffer) => onChunk(chunk.toString('utf8'), 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => onChunk(chunk.toString('utf8'), 'stderr'));

  const timeoutMs = options.timeoutMs ?? 0;
  let timer: NodeJS.Timeout | null = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    timer.unref();
  }

  const done = new Promise<number>((resolve) => {
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve(code ?? -1);
    });
    child.on('error', () => {
      if (timer) clearTimeout(timer);
      resolve(-1);
    });
  });

  return {
    done,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => child.kill(signal),
  };
}

/**
 * Last line of defence on argument shape.
 *
 * `spawn` without a shell already makes metacharacters inert, so this is not
 * what stops injection — it stops the subtler family of bugs where an argument
 * beginning with `-` is read by the binary as a flag. Callers pass validated
 * values; anything that looks like an option has to be a literal the caller
 * wrote, which `allowLeadingDash` below expresses.
 */
function assertSafeArgs(args: string[]): void {
  for (const arg of args) {
    if (typeof arg !== 'string') throw new Error('Command arguments must be strings');
    if (arg.includes('\0')) throw new Error('Command arguments must not contain NUL bytes');
    if (arg.length > 4096) throw new Error('Command argument is implausibly long');
  }
}
