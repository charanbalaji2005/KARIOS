/**
 * Client for the KAIROS server agent.
 *
 * The API never touches the host itself. It sends a signed request to the
 * agent over a Unix domain socket and the agent decides whether the named
 * operation is one it is willing to perform. That split is the whole security
 * story of the server console: the process that is reachable from the internet
 * has no privilege, and the process with privilege is not reachable from the
 * internet.
 *
 *   this (API, unprivileged) ──unix socket──▶ agent (root) ──▶ Ubuntu
 *
 * Every request is HMAC-signed over method, path, body, a timestamp and a
 * nonce, so a captured request cannot be replayed and a `GET /agent/system`
 * cannot be edited into a `POST /agent/server/reboot`.
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { ApiError } from './errors.js';

/* ----------------------------------------------------------------- auth */

/**
 * The shared secret, read once at start-up.
 *
 * Read from a file rather than passed in the environment where possible: an
 * environment variable is visible in `/proc/<pid>/environ` to anything running
 * as the same user, and gets copied into crash reports.
 */
function loadToken(): string | null {
  if (env.KAIROS_AGENT_TOKEN) return env.KAIROS_AGENT_TOKEN.trim();
  if (existsSync(env.KAIROS_AGENT_TOKEN_FILE)) {
    try {
      const contents = readFileSync(env.KAIROS_AGENT_TOKEN_FILE, 'utf8').trim();
      if (contents) return contents;
    } catch (error) {
      logger.warn({ err: error, path: env.KAIROS_AGENT_TOKEN_FILE }, 'Could not read the agent token file');
    }
  }
  return null;
}

let token: string | null = null;
let tokenLoaded = false;

function agentToken(): string {
  if (!tokenLoaded) {
    token = loadToken();
    tokenLoaded = true;
  }
  if (!token) {
    throw new ApiError(
      'AGENT_UNAVAILABLE',
      'No server agent credential is configured, so the API cannot manage this host. ' +
        'Run scripts/install-server.sh, or set KAIROS_AGENT_TOKEN_FILE.',
    );
  }
  return token;
}

/** Whether an agent is configured at all, for the "is this a server install" check. */
export function agentConfigured(): boolean {
  if (!tokenLoaded) {
    token = loadToken();
    tokenLoaded = true;
  }
  return token !== null;
}

function signHeaders(method: string, path: string, body: string): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', agentToken())
    .update([timestamp, nonce, method.toUpperCase(), path, body].join('\n'))
    .digest('hex');
  return {
    'x-kairos-timestamp': timestamp,
    'x-kairos-nonce': nonce,
    'x-kairos-signature': signature,
  };
}

/* -------------------------------------------------------------- request */

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * Where to reach the agent.
 *
 * The socket is the supported path. The loopback fallback exists for the case
 * where the API runs in a container that cannot see the host's filesystem, and
 * it is 127.0.0.1 only — see the agent's own config for why that matters.
 */
function transport(): { socketPath?: string; host?: string; port?: number } {
  if (env.KAIROS_AGENT_TCP_PORT) {
    return { host: '127.0.0.1', port: env.KAIROS_AGENT_TCP_PORT };
  }
  return { socketPath: env.KAIROS_AGENT_SOCKET };
}

function open(options: RequestOptions, headers: Record<string, string>): ClientRequest {
  return httpRequest({
    ...transport(),
    method: options.method,
    path: options.path,
    headers,
  });
}

export interface AgentResponse<T = unknown> {
  ok: boolean;
  operation?: string;
  data?: T;
  text?: string;
  exitCode?: number;
  durationMs?: number;
  error?: { code: string; message: string };
}

/**
 * Turn a transport-level failure into something an operator can act on.
 *
 * "ENOENT" on a socket path means the agent is not running, which is a
 * completely different problem from "the operation failed", and the dashboard
 * should say so rather than showing a generic error.
 */
function describeTransportError(error: NodeJS.ErrnoException): ApiError {
  const target = env.KAIROS_AGENT_TCP_PORT ? `127.0.0.1:${env.KAIROS_AGENT_TCP_PORT}` : env.KAIROS_AGENT_SOCKET;

  if (error.code === 'ENOENT') {
    return new ApiError(
      'AGENT_UNAVAILABLE',
      `The server agent is not running (nothing is listening at ${target}). Start it with: systemctl start kairos-server-agent`,
    );
  }
  if (error.code === 'EACCES') {
    return new ApiError(
      'AGENT_UNAVAILABLE',
      `Permission denied on ${target}. The API's user must be in the "kairos" group for the agent socket to be readable.`,
    );
  }
  if (error.code === 'ECONNREFUSED') {
    return new ApiError('AGENT_UNAVAILABLE', `The server agent refused the connection at ${target}.`);
  }
  return new ApiError('AGENT_UNAVAILABLE', `Could not reach the server agent: ${error.message}`);
}

async function send<T>(options: RequestOptions): Promise<AgentResponse<T>> {
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...signHeaders(options.method, options.path, body),
  };

  return await new Promise<AgentResponse<T>>((resolve, reject) => {
    const req = open(options, headers);

    req.setTimeout(options.timeoutMs ?? 60_000, () => {
      req.destroy(new Error('The server agent did not respond in time'));
    });

    req.on('error', (error) => reject(describeTransportError(error as NodeJS.ErrnoException)));

    req.on('response', (res: IncomingMessage) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        // The agent caps its own output; this is the second cap, in case it
        // ever does not.
        if (raw.length < 16 * 1024 * 1024) raw += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw) as AgentResponse<T>);
        } catch {
          reject(new ApiError('AGENT_UNAVAILABLE', 'The server agent returned a response the API could not parse'));
        }
      });
      res.on('error', reject);
    });

    req.end(body);
  });
}

/* ---------------------------------------------------------------- calls */

export interface AgentHealth {
  version: string;
  pid: number;
  uptimeSeconds: number;
  socket: string;
  dataRoot: string;
  operations: number;
  startedAt: string;
}

export async function agentHealth(): Promise<AgentHealth> {
  const response = await send<AgentHealth>({ method: 'GET', path: '/agent/health', timeoutMs: 10_000 });
  if (!response.ok || !response.data) {
    throw new ApiError('AGENT_UNAVAILABLE', response.error?.message ?? 'The agent is not healthy');
  }
  return response.data;
}

/** True when the agent answers. Used for status badges, so it never throws. */
export async function agentReachable(): Promise<{ reachable: boolean; detail: string; health: AgentHealth | null }> {
  if (!agentConfigured()) {
    return {
      reachable: false,
      detail: 'No agent credential is configured. This installation is not set up to manage its host.',
      health: null,
    };
  }
  try {
    const health = await agentHealth();
    return { reachable: true, detail: `agent ${health.version}, up ${Math.round(health.uptimeSeconds / 60)}m`, health };
  } catch (error) {
    return { reachable: false, detail: error instanceof ApiError ? error.message : 'unreachable', health: null };
  }
}

export interface OperationDescriptor {
  id: string;
  summary: string;
  category: string;
  danger: boolean;
  confirmPhrase: string | null;
  streaming: boolean;
  args: { name: string; type: string; required: boolean; values?: readonly string[]; describe?: string }[];
}

export async function listAgentOperations(): Promise<OperationDescriptor[]> {
  const response = await send<{ operations: OperationDescriptor[] }>({
    method: 'GET',
    path: '/agent/operations',
    timeoutMs: 10_000,
  });
  if (!response.ok || !response.data) {
    throw new ApiError('AGENT_UNAVAILABLE', response.error?.message ?? 'Could not read the agent allowlist');
  }
  return response.data.operations;
}

export interface ExecuteOptions {
  operation: string;
  args?: Record<string, unknown>;
  confirm?: string;
  timeoutMs?: number;
}

/**
 * Run one operation and wait for the result.
 *
 * Note that a failed *operation* comes back as `ok: false` with a message,
 * not as a thrown error — "PostgreSQL would not restart" is an answer, and the
 * dashboard needs the text the agent produced along the way to show why.
 * Thrown errors are reserved for "could not reach the agent at all".
 */
export async function executeOperation<T = unknown>(options: ExecuteOptions): Promise<AgentResponse<T>> {
  return await send<T>({
    method: 'POST',
    path: '/agent/execute',
    body: { operation: options.operation, args: options.args ?? {}, confirm: options.confirm },
    // Generous, because backup_create and package installs are legitimately
    // slow. The agent enforces its own per-operation timeout inside this.
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
  });
}

/**
 * Convenience for the many read-only operations whose data the dashboard wants
 * and whose failure is worth surfacing as an error rather than a payload.
 */
export async function readOperation<T>(operation: string, args?: Record<string, unknown>): Promise<T> {
  const response = await executeOperation<T>({ operation, args, timeoutMs: 120_000 });
  if (!response.ok) {
    throw new ApiError('AGENT_OPERATION_FAILED', response.error?.message ?? `${operation} failed`);
  }
  return response.data as T;
}

/* ------------------------------------------------------------ streaming */

export type StreamFrame =
  | { type: 'start'; operation: string | null; display?: string }
  | { type: 'out'; data: string }
  | { type: 'control'; action: string }
  | { type: 'done'; exitCode: number; data: unknown; operation?: string | null }
  | { type: 'error'; message: string };

/**
 * Run an operation and receive NDJSON frames as they are produced.
 *
 * Returns a handle rather than a promise of the whole output, because the
 * point is the output arriving early — a `logs_follow` never finishes.
 */
export interface StreamHandle {
  /** Resolves once the agent closes the response. */
  done: Promise<void>;
  /** Abort the operation and close the connection. */
  close(): void;
}

export function streamOperation(
  options: { operation: string; args?: Record<string, unknown>; confirm?: string; path?: '/agent/stream' | '/agent/shell'; line?: string },
  onFrame: (frame: StreamFrame) => void,
): StreamHandle {
  const path = options.path ?? '/agent/stream';
  const payload =
    path === '/agent/shell'
      ? { line: options.line ?? '', confirm: options.confirm }
      : { operation: options.operation, args: options.args ?? {}, confirm: options.confirm };

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...signHeaders('POST', path, body),
  };

  let request: ClientRequest;

  const done = new Promise<void>((resolve) => {
    request = open({ method: 'POST', path }, headers);

    request.on('error', (error) => {
      const described = describeTransportError(error as NodeJS.ErrnoException);
      onFrame({ type: 'error', message: described.message });
      resolve();
    });

    request.on('response', (res: IncomingMessage) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            onFrame(JSON.parse(line) as StreamFrame);
          } catch {
            // A partial frame should never happen given the newline framing,
            // but dropping one is better than tearing down the stream.
          }
        }
      });
      res.on('end', () => resolve());
      res.on('error', () => resolve());
    });

    request.end(body);
  });

  return {
    done,
    close: () => request?.destroy(),
  };
}

/* ------------------------------------------------------------------ pty */

export type PtyFrame =
  | { type: 'ready'; sessionId: string; backend: string; resizable: boolean; idleTimeoutMs: number; maxLifetimeMs: number }
  | { type: 'out'; data: string }
  | { type: 'exit'; code: number; reason: string };

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  signal(name: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void;
  close(): void;
  done: Promise<void>;
}

/**
 * Open a real terminal on the host.
 *
 * Full-duplex over one HTTP request: the request body stays open and carries
 * input frames while the response streams output. The API is a pipe here and
 * nothing more — it does not interpret a single byte of what is typed, which
 * is why it cannot be tricked into interpreting it wrongly.
 */
export function openPty(
  options: { cols: number; rows: number },
  onFrame: (frame: PtyFrame) => void,
): PtyHandle {
  const path = `/agent/pty?cols=${Math.round(options.cols)}&rows=${Math.round(options.rows)}`;
  const headers: Record<string, string> = {
    'content-type': 'application/x-ndjson',
    // The body streams, so it is signed as empty. Path and query are signed,
    // which is what stops this being replayed as a different route.
    ...signHeaders('POST', path, ''),
  };

  let request: ClientRequest;
  let closed = false;

  const done = new Promise<void>((resolve) => {
    request = httpRequest({ ...transport(), method: 'POST', path, headers });

    request.on('error', (error) => {
      const described = describeTransportError(error as NodeJS.ErrnoException);
      onFrame({ type: 'exit', code: -1, reason: described.message });
      resolve();
    });

    request.on('response', (res: IncomingMessage) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            onFrame(JSON.parse(line) as PtyFrame);
          } catch {
            // ignore malformed frame
          }
        }
      });
      res.on('end', () => resolve());
      res.on('error', () => resolve());
    });

    // Deliberately not ended: the body stays open for input.
    request.flushHeaders();
  });

  const write = (frame: unknown) => {
    if (closed) return;
    request?.write(JSON.stringify(frame) + '\n');
  };

  return {
    write: (data) => write({ type: 'input', data }),
    resize: (cols, rows) => write({ type: 'resize', cols, rows }),
    signal: (name) => write({ type: 'signal', signal: name }),
    close: () => {
      if (closed) return;
      closed = true;
      try {
        request?.write(JSON.stringify({ type: 'close' }) + '\n');
        request?.end();
      } catch {
        // Already gone.
      }
      request?.destroy();
    },
    done,
  };
}
