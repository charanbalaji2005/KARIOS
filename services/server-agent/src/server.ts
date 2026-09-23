/**
 * The agent's HTTP surface.
 *
 * Bound to a Unix domain socket, not a port. That is the primary access
 * control: a socket at /run/kairos/server-agent.sock owned by root:kairos with
 * mode 0660 cannot be reached across the network at all, whatever a
 * misconfigured firewall does, because there is nothing listening on the
 * network to reach.
 *
 * The routes are deliberately few, and none of them takes a command:
 *
 *   GET  /agent/health       liveness and version
 *   GET  /agent/operations   the allowlist, enumerated
 *   POST /agent/execute      run one operation by id, buffered
 *   POST /agent/stream       run one operation by id, streamed as NDJSON
 *   POST /agent/shell        parse a KAIROS Shell line, then run what it resolves to
 *   POST /agent/pty          a real terminal, full-duplex NDJSON
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { unlink, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from './config.js';
import { log } from './log.js';
import { verify } from './auth.js';
import { getOperation, describeOperations, type Operation } from './registry.js';
import { parseArgs, ValidationError } from './validate.js';
import { parse as parseShell, ShellError, helpText, operationsText } from './shell.js';
import { openPty, superviseSession } from './pty.js';

/* ----------------------------------------------------------------- util */

const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function startStream(res: ServerResponse): (frame: unknown) => void {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-store',
    // Chunked, so the caller sees output as it is produced rather than at the
    // end — which is the entire reason a log viewer is useful.
    'transfer-encoding': 'chunked',
  });
  return (frame: unknown) => {
    if (!res.writableEnded) res.write(JSON.stringify(frame) + '\n');
  };
}

/* ------------------------------------------------------------- dispatch */

export interface ExecuteRequest {
  operation: string;
  args?: Record<string, unknown>;
  /** Required, and must match exactly, for operations marked dangerous. */
  confirm?: string;
}

/**
 * Resolve and validate a request into something runnable.
 *
 * Everything that can reject a request happens here, before any process is
 * spawned: unknown operation, bad arguments, missing confirmation. The caller
 * gets one error shape whichever it was.
 */
function prepare(request: ExecuteRequest): { operation: Operation; args: ReturnType<typeof parseArgs> } {
  if (!request || typeof request.operation !== 'string') {
    throw new ValidationError('An operation id is required');
  }

  const operation = getOperation(request.operation);
  if (!operation) {
    // Do not echo the requested id back verbatim into a log line that a human
    // will read in a terminal; it is attacker-controlled text.
    throw new ValidationError(`Unknown operation. Call GET /agent/operations for the list.`);
  }

  const args = parseArgs(operation.args, request.args ?? {});

  if (operation.danger) {
    if (request.confirm !== operation.confirmPhrase) {
      throw new ValidationError(
        `"${operation.id}" is a dangerous operation and requires confirmation. ` +
          `Send confirm: "${operation.confirmPhrase}".`,
      );
    }
  }

  return { operation, args };
}

interface RunOutcome {
  data: unknown;
  text: string;
  exitCode: number;
}

async function runOperation(
  operation: Operation,
  args: ReturnType<typeof parseArgs>,
  emit: (text: string) => void,
  signal: AbortSignal,
): Promise<RunOutcome> {
  const timeout = AbortSignal.timeout(operation.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);

  const result = await operation.run({ args, emit, signal: combined });
  return {
    data: result.data ?? null,
    text: result.text ?? '',
    exitCode: result.exitCode ?? 0,
  };
}

/* --------------------------------------------------------------- routes */

async function handleExecute(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  let request: ExecuteRequest;
  try {
    request = JSON.parse(body || '{}') as ExecuteRequest;
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Body must be JSON' } });
    return;
  }

  let prepared: ReturnType<typeof prepare>;
  try {
    prepared = prepare(request);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_OPERATION', message: (error as Error).message } });
    return;
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  // Buffered mode still collects streamed output so nothing an operation
  // emitted is lost just because the caller asked for it all at once.
  let streamed = '';
  const emit = (text: string) => {
    if (streamed.length < config.maxOutputBytes) streamed += text;
  };

  const startedAt = Date.now();
  try {
    const outcome = await runOperation(prepared.operation, prepared.args, emit, controller.signal);
    log.info('operation completed', {
      operation: prepared.operation.id,
      exitCode: outcome.exitCode,
      durationMs: Date.now() - startedAt,
    });
    sendJson(res, 200, {
      ok: true,
      operation: prepared.operation.id,
      data: outcome.data,
      text: streamed + outcome.text,
      exitCode: outcome.exitCode,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = (error as Error).message;
    log.warn('operation failed', { operation: prepared.operation.id, message });
    sendJson(res, 200, {
      ok: false,
      operation: prepared.operation.id,
      text: streamed,
      error: { code: 'OPERATION_FAILED', message },
      durationMs: Date.now() - startedAt,
    });
  }
}

async function handleStream(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  let request: ExecuteRequest;
  try {
    request = JSON.parse(body || '{}') as ExecuteRequest;
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Body must be JSON' } });
    return;
  }

  let prepared: ReturnType<typeof prepare>;
  try {
    prepared = prepare(request);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: { code: 'INVALID_OPERATION', message: (error as Error).message } });
    return;
  }

  const send = startStream(res);
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  res.on('close', () => controller.abort());

  send({ type: 'start', operation: prepared.operation.id });

  try {
    const outcome = await runOperation(
      prepared.operation,
      prepared.args,
      (text) => send({ type: 'out', data: text }),
      controller.signal,
    );
    if (outcome.text) send({ type: 'out', data: outcome.text.endsWith('\n') ? outcome.text : outcome.text + '\n' });
    send({ type: 'done', exitCode: outcome.exitCode, data: outcome.data });
  } catch (error) {
    send({ type: 'error', message: (error as Error).message });
  } finally {
    res.end();
  }
}

/**
 * KAIROS Shell.
 *
 * The line is parsed here and the *result* of parsing is an operation id. The
 * line itself never reaches a process.
 */
async function handleShell(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  let request: { line?: string; confirm?: string };
  try {
    request = JSON.parse(body || '{}') as { line?: string; confirm?: string };
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Body must be JSON' } });
    return;
  }

  const line = typeof request.line === 'string' ? request.line : '';
  if (line.length > 2_000) {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Command line is too long' } });
    return;
  }

  const send = startStream(res);

  let parsed;
  try {
    parsed = parseShell(line);
  } catch (error) {
    if (error instanceof ShellError) {
      send({ type: 'start', operation: null, display: line });
      if (error.message) send({ type: 'out', data: error.message + '\n' });
      for (const suggestion of error.suggestions) send({ type: 'out', data: suggestion + '\n' });
      send({ type: 'done', exitCode: 127, data: null, operation: null });
      res.end();
      return;
    }
    throw error;
  }

  /* ---- built-ins, which run no operation at all -------------------- */
  if (parsed.operation === '__help') {
    send({ type: 'start', operation: 'help', display: parsed.display });
    send({ type: 'out', data: helpText() + '\n' });
    send({ type: 'done', exitCode: 0, data: null, operation: 'help' });
    res.end();
    return;
  }
  if (parsed.operation === '__operations') {
    send({ type: 'start', operation: 'operations', display: parsed.display });
    send({ type: 'out', data: operationsText() + '\n' });
    send({ type: 'done', exitCode: 0, data: null, operation: 'operations' });
    res.end();
    return;
  }
  if (parsed.operation === '__clear' || parsed.operation === '__exit') {
    send({ type: 'start', operation: parsed.operation.slice(2), display: parsed.display });
    send({ type: 'control', action: parsed.operation.slice(2) });
    send({ type: 'done', exitCode: 0, data: null, operation: parsed.operation.slice(2) });
    res.end();
    return;
  }

  let prepared: ReturnType<typeof prepare>;
  try {
    prepared = prepare({ operation: parsed.operation, args: parsed.args, confirm: request.confirm });
  } catch (error) {
    send({ type: 'start', operation: parsed.operation, display: parsed.display });
    send({ type: 'out', data: (error as Error).message + '\n' });
    send({ type: 'done', exitCode: 126, data: null, operation: parsed.operation });
    res.end();
    return;
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  res.on('close', () => controller.abort());

  send({ type: 'start', operation: prepared.operation.id, display: parsed.display });

  try {
    const outcome = await runOperation(
      prepared.operation,
      prepared.args,
      (text) => send({ type: 'out', data: text }),
      controller.signal,
    );
    if (outcome.text) send({ type: 'out', data: outcome.text.endsWith('\n') ? outcome.text : outcome.text + '\n' });
    send({ type: 'done', exitCode: outcome.exitCode, data: outcome.data, operation: prepared.operation.id });
  } catch (error) {
    send({ type: 'out', data: `${(error as Error).message}\n` });
    send({ type: 'done', exitCode: 1, data: null, operation: prepared.operation.id });
  } finally {
    res.end();
  }
}

/**
 * The Ubuntu Terminal.
 *
 * Full-duplex over one HTTP/1.1 request: the request body stays open and
 * carries input frames while the response streams output frames. That avoids
 * putting a WebSocket implementation inside a process running as root, which
 * is a meaningful amount of parsing code not to have here.
 */
async function handlePty(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const cols = Math.min(500, Math.max(20, Number(url.searchParams.get('cols')) || 80));
  const rows = Math.min(200, Math.max(5, Number(url.searchParams.get('rows')) || 24));

  let session;
  try {
    session = await openPty({ cols, rows });
  } catch (error) {
    sendJson(res, 503, { ok: false, error: { code: 'PTY_UNAVAILABLE', message: (error as Error).message } });
    return;
  }

  const send = startStream(res);
  send({
    type: 'ready',
    sessionId: session.id,
    backend: session.backend,
    resizable: session.resizable,
    idleTimeoutMs: config.ptyIdleTimeoutMs,
    maxLifetimeMs: config.ptyMaxLifetimeMs,
  });

  log.warn('ubuntu terminal opened', { sessionId: session.id, backend: session.backend });

  const supervisor = superviseSession(session, (reason) => {
    send({ type: 'exit', code: 0, reason });
    if (!res.writableEnded) res.end();
    log.warn('ubuntu terminal closed', { sessionId: session.id, reason });
  });

  session.onData((data) => send({ type: 'out', data }));
  session.onExit((code) => {
    send({ type: 'exit', code, reason: 'the shell exited' });
    if (!res.writableEnded) res.end();
  });

  /* ---- input frames, arriving on the still-open request body ------- */
  let buffer = '';
  req.on('data', (chunk: Buffer) => {
    supervisor.touch();
    buffer += chunk.toString('utf8');

    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!raw.trim()) continue;

      let frame: { type?: string; data?: string; cols?: number; rows?: number; signal?: string };
      try {
        frame = JSON.parse(raw) as typeof frame;
      } catch {
        continue;
      }

      switch (frame.type) {
        case 'input':
          if (typeof frame.data === 'string') session.write(frame.data);
          break;
        case 'resize':
          if (typeof frame.cols === 'number' && typeof frame.rows === 'number') {
            session.resize(Math.min(500, Math.max(20, frame.cols)), Math.min(200, Math.max(5, frame.rows)));
          }
          break;
        case 'signal':
          // Ctrl-C arrives as an input byte from xterm.js; this is for the
          // UI's explicit "terminate" button.
          if (frame.signal === 'SIGINT' || frame.signal === 'SIGTERM' || frame.signal === 'SIGHUP') {
            session.kill(frame.signal);
          }
          break;
        case 'close':
          supervisor.stop();
          break;
      }
    }
  });

  req.on('close', () => supervisor.stop());
  res.on('close', () => supervisor.stop());
}

/* --------------------------------------------------------------- server */

function route(req: IncomingMessage): { method: string; path: string; url: URL } {
  // The Host header is irrelevant on a unix socket; a fixed base keeps URL
  // parsing honest.
  const url = new URL(req.url ?? '/', 'http://agent.local');
  return { method: (req.method ?? 'GET').toUpperCase(), path: url.pathname, url };
}

export function createAgentServer(): Server {
  return createServer((req, res) => {
    void (async () => {
      const { method, path, url } = route(req);
      const started = Date.now();

      try {
        // The PTY route keeps its request body open for input, so it cannot be
        // read up front. It signs over an empty body plus the path and query.
        const streamingBody = path === '/agent/pty';
        const body = streamingBody ? '' : await readBody(req);

        const signaturePath = url.pathname + (url.search || '');
        const verification = verify(req.headers, method, signaturePath, body);
        if (!verification.ok) {
          log.warn('rejected unauthenticated request', { path, reason: verification.reason });
          sendJson(res, 401, { ok: false, error: { code: 'UNAUTHENTICATED', message: verification.reason } });
          return;
        }

        if (method === 'GET' && path === '/agent/health') {
          sendJson(res, 200, {
            ok: true,
            data: {
              version: config.version,
              pid: process.pid,
              uptimeSeconds: Math.round(process.uptime()),
              socket: config.socketPath,
              dataRoot: config.dataRoot,
              operations: describeOperations().length,
              startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
            },
          });
          return;
        }

        if (method === 'GET' && path === '/agent/operations') {
          sendJson(res, 200, { ok: true, data: { operations: describeOperations() } });
          return;
        }

        if (method === 'POST' && path === '/agent/execute') {
          await handleExecute(req, res, body);
          return;
        }

        if (method === 'POST' && path === '/agent/stream') {
          await handleStream(req, res, body);
          return;
        }

        if (method === 'POST' && path === '/agent/shell') {
          await handleShell(req, res, body);
          return;
        }

        if (method === 'POST' && path === '/agent/pty') {
          await handlePty(req, res, url);
          return;
        }

        sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No agent route for ${method} ${path}` } });
      } catch (error) {
        log.error('request handler threw', { path, message: (error as Error).message });
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: { code: 'AGENT_ERROR', message: 'The agent failed to handle the request' } });
        } else if (!res.writableEnded) {
          res.end();
        }
      } finally {
        log.debug('request', { method, path, durationMs: Date.now() - started });
      }
    })();
  });
}

/**
 * Bind the socket, then lock it down.
 *
 * Order matters: the socket exists and is connectable the moment `listen`
 * returns, so the permissions are narrowed immediately afterwards and any
 * failure to do so takes the agent down rather than leaving a world-writable
 * root-capable socket on the filesystem.
 */
export async function listen(server: Server): Promise<void> {
  const socketDir = dirname(config.socketPath);
  await mkdir(socketDir, { recursive: true, mode: 0o750 });

  // A socket file left behind by a crash makes bind fail with EADDRINUSE.
  if (existsSync(config.socketPath)) {
    await unlink(config.socketPath).catch(() => undefined);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // 0660: owner (root) and group (kairos). Not 0666, which would let every
  // local user restart PostgreSQL.
  await chmod(config.socketPath, 0o660);

  try {
    // Node has no chown-by-group-name, and adding a native dependency for it
    // would be absurd. `chgrp` is in coreutils on every Ubuntu install.
    execFileSync('/usr/bin/chgrp', [config.socketGroup, config.socketPath], { stdio: 'ignore' });
    log.info('socket listening', { path: config.socketPath, group: config.socketGroup, mode: '0660' });
  } catch {
    log.warn(
      'could not set the socket group — only root can reach the agent until this is fixed',
      { path: config.socketPath, group: config.socketGroup },
    );
  }

  if (config.tcpPort) {
    const tcp = createAgentServer();
    await new Promise<void>((resolve) => tcp.listen(config.tcpPort!, config.tcpHost, resolve));
    log.warn('loopback fallback listening — prefer the unix socket', {
      host: config.tcpHost,
      port: config.tcpPort,
    });
  }
}
