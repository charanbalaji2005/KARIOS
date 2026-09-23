'use client';

/**
 * The server terminal.
 *
 * A real xterm.js instance over a WebSocket, not a styled textarea. That
 * matters for more than looks: `kairos doctor` emits ANSI colour, `journalctl`
 * output relies on column alignment, and the Ubuntu Terminal mode runs a login
 * shell where anything less than a real emulator breaks the moment someone
 * runs `top` or hits Ctrl-C.
 *
 * Two modes share this component:
 *
 *   kairos_shell     the client owns the line editor and sends whole commands.
 *                    The server has no PTY, so there is nothing to echo
 *                    keystrokes back — this component does it.
 *   ubuntu_terminal  every keystroke goes straight down the socket and the
 *                    host's PTY does the echoing. This component interprets
 *                    nothing.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { WS_URL } from '@/lib/api';

export type TerminalMode = 'kairos_shell' | 'ubuntu_terminal';
export type ConnectionState = 'connecting' | 'connected' | 'closed' | 'error';

export interface TerminalHandle {
  clear(): void;
  focus(): void;
  reconnect(): void;
  /** Everything printed so far, for the download button. */
  transcript(): string;
  /**
   * Re-send a command with the confirmation phrase the agent asked for.
   * Lives here rather than in the page so the page never holds the socket.
   */
  sendConfirmed(line: string, confirm: string): void;
}

interface Props {
  mode: TerminalMode;
  /** Redeemed once by the socket; the parent fetches a fresh one per connection. */
  requestTicket: () => Promise<string>;
  onState?: (state: ConnectionState, detail?: string) => void;
  /** Raised when a dangerous operation needs a typed confirmation. */
  onConfirmRequired?: (info: { line: string; message: string; confirmPhrase: string | null }) => void;
  className?: string;
}

interface ServerFrame {
  type: string;
  data?: string;
  message?: string;
  banner?: string;
  mode?: string;
  sessionId?: string;
  serverId?: string;
  backend?: string;
  resizable?: boolean;
  exitCode?: number;
  operation?: string;
  action?: string;
}

const THEME = {
  background: '#10131A',
  foreground: '#DCE1EA',
  cursor: '#7C6BF2',
  cursorAccent: '#10131A',
  selectionBackground: '#2A303C',
  black: '#171B24',
  red: '#E4685D',
  green: '#4FC48B',
  yellow: '#E2A23B',
  blue: '#7C6BF2',
  magenta: '#B48EF2',
  cyan: '#4FC4C4',
  white: '#DCE1EA',
  brightBlack: '#7F8898',
  brightRed: '#F08A80',
  brightGreen: '#72D6A6',
  brightYellow: '#EFBB6A',
  brightBlue: '#9A8CF5',
  brightMagenta: '#C9ADF6',
  brightCyan: '#7AD6D6',
  brightWhite: '#FFFFFF',
};

const PROMPT = '\x1b[38;5;141mkairos\x1b[0m$ ';

export const ServerTerminal = forwardRef<TerminalHandle, Props>(function ServerTerminal(
  { mode, requestTicket, onState, onConfirmRequired, className = '' },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const transcriptRef = useRef<string>('');

  /* Line editor state for kairos_shell mode. */
  const lineRef = useRef('');
  const cursorRef = useRef(0);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const busyRef = useRef(false);
  const lastCommandRef = useRef('');

  const [generation, setGeneration] = useState(0);

  const write = useCallback((text: string) => {
    transcriptRef.current += text;
    // Keep the transcript bounded; the scrollback already holds what is on
    // screen and an unbounded string is a memory leak on a long session.
    if (transcriptRef.current.length > 2_000_000) {
      transcriptRef.current = transcriptRef.current.slice(-1_000_000);
    }
    termRef.current?.write(text);
  }, []);

  const prompt = useCallback(() => {
    lineRef.current = '';
    cursorRef.current = 0;
    write(`\r\n${PROMPT}`);
  }, [write]);

  /** Redraw the current line after an edit. */
  const redraw = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    // \r to column 0, \x1b[K to clear to end of line, then reprint.
    term.write(`\r\x1b[K${PROMPT}${lineRef.current}`);
    const back = lineRef.current.length - cursorRef.current;
    if (back > 0) term.write(`\x1b[${back}D`);
  }, []);

  /* ------------------------------------------------------ mount xterm */

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    void (async () => {
      // xterm touches `window` on import, so it cannot be imported at module
      // scope in a Next.js app that renders on the server first.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !hostRef.current) return;

      const term = new Terminal({
        theme: THEME,
        fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, monospace',
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        // Enough to scroll back through a `journalctl -n 1000` without losing
        // the top of it.
        scrollback: 10_000,
        convertEol: false,
        allowProposedApi: true,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      termRef.current = term;
      fitRef.current = fit;

      resizeObserver = new ResizeObserver(() => {
        try {
          fit.fit();
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        } catch {
          // fit() throws if the element is hidden (a collapsed tab). Harmless.
        }
      });
      resizeObserver.observe(hostRef.current);

      term.focus();
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, []);

  /* ------------------------------------------------------- connect ws */

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;

    const connect = async () => {
      onState?.('connecting');
      let ticket: string;
      try {
        ticket = await requestTicket();
      } catch (error) {
        if (cancelled) return;
        onState?.('error', (error as Error).message);
        write(`\r\n\x1b[31m${(error as Error).message}\x1b[0m\r\n`);
        return;
      }
      if (cancelled) return;

      const term = termRef.current;
      const params = new URLSearchParams({ ticket, mode });
      if (term) {
        params.set('cols', String(term.cols));
        params.set('rows', String(term.rows));
      }

      socket = new WebSocket(`${WS_URL}/api/v1/admin/server/terminal?${params.toString()}`);
      socketRef.current = socket;

      socket.onopen = () => onState?.('connected');

      socket.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(event.data as string) as ServerFrame;
        } catch {
          return;
        }

        switch (frame.type) {
          case 'ready':
            if (frame.banner) write(frame.banner.replace(/\n/g, '\r\n'));
            if (mode === 'kairos_shell') prompt();
            break;

          case 'output':
            write(frame.data ?? '');
            break;

          case 'control':
            if (frame.action === 'clear') {
              termRef.current?.clear();
              transcriptRef.current = '';
            } else if (frame.action === 'exit') {
              socket?.close(1000, 'exit');
            }
            break;

          case 'done':
            busyRef.current = false;
            // 126 is the agent's "refused": a dangerous operation without the
            // confirmation phrase. Surface it as a dialog rather than leaving
            // the operator to retype the command with a flag they cannot guess.
            if (frame.exitCode === 126 && onConfirmRequired) {
              onConfirmRequired({
                line: lastCommandRef.current,
                message: 'This operation needs confirmation.',
                confirmPhrase: null,
              });
            }
            if (mode === 'kairos_shell') prompt();
            break;

          case 'error':
            write(`\r\n\x1b[31m${frame.message ?? 'error'}\x1b[0m\r\n`);
            busyRef.current = false;
            if (mode === 'kairos_shell') prompt();
            break;
        }
      };

      socket.onerror = () => onState?.('error', 'The connection failed.');

      socket.onclose = (event) => {
        socketRef.current = null;
        onState?.('closed', event.reason || undefined);
        write(`\r\n\x1b[2m[disconnected${event.reason ? `: ${event.reason}` : ''}]\x1b[0m\r\n`);
      };
    };

    void connect();

    return () => {
      cancelled = true;
      socket?.close(1000, 'navigating away');
      socketRef.current = null;
    };
    // `generation` is the reconnect trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, generation]);

  /* ------------------------------------------------------ keystrokes */

  useEffect(() => {
    const term = termRef.current;
    if (!term) return undefined;

    const disposable = term.onData((data: string) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      /* ---- Ubuntu Terminal: raw passthrough ---------------------- */
      if (mode === 'ubuntu_terminal') {
        socket.send(JSON.stringify({ type: 'input', data }));
        return;
      }

      /* ---- KAIROS Shell: local line editing ---------------------- */

      // Ctrl-C: abandon the line. The agent enforces its own timeouts, so
      // there is no long-running command to interrupt from here.
      if (data === '\u0003') {
        if (busyRef.current) {
          write('^C\r\n\x1b[2m(the operation will finish on the server)\x1b[0m');
          return;
        }
        write('^C');
        prompt();
        return;
      }

      if (busyRef.current) return;

      // Enter
      if (data === '\r') {
        const line = lineRef.current.trim();
        write('\r\n');
        if (!line) {
          prompt();
          return;
        }
        historyRef.current = [line, ...historyRef.current.filter((entry) => entry !== line)].slice(0, 200);
        historyIndexRef.current = -1;
        lastCommandRef.current = line;
        busyRef.current = true;
        socket.send(JSON.stringify({ type: 'command', line }));
        return;
      }

      // Backspace
      if (data === '\u007f') {
        if (cursorRef.current > 0) {
          lineRef.current =
            lineRef.current.slice(0, cursorRef.current - 1) + lineRef.current.slice(cursorRef.current);
          cursorRef.current -= 1;
          redraw();
        }
        return;
      }

      // Arrows and history
      if (data === '\x1b[A' || data === '\x1b[B') {
        const history = historyRef.current;
        if (history.length === 0) return;
        if (data === '\x1b[A') {
          historyIndexRef.current = Math.min(historyIndexRef.current + 1, history.length - 1);
        } else {
          historyIndexRef.current = Math.max(historyIndexRef.current - 1, -1);
        }
        lineRef.current = historyIndexRef.current >= 0 ? history[historyIndexRef.current]! : '';
        cursorRef.current = lineRef.current.length;
        redraw();
        return;
      }
      if (data === '\x1b[D') {
        if (cursorRef.current > 0) {
          cursorRef.current -= 1;
          term.write('\x1b[D');
        }
        return;
      }
      if (data === '\x1b[C') {
        if (cursorRef.current < lineRef.current.length) {
          cursorRef.current += 1;
          term.write('\x1b[C');
        }
        return;
      }
      // Home / End
      if (data === '\x1b[H' || data === '\u0001') {
        cursorRef.current = 0;
        redraw();
        return;
      }
      if (data === '\x1b[F' || data === '\u0005') {
        cursorRef.current = lineRef.current.length;
        redraw();
        return;
      }
      // Ctrl-U: clear the line
      if (data === '\u0015') {
        lineRef.current = '';
        cursorRef.current = 0;
        redraw();
        return;
      }
      // Ctrl-L: clear the screen
      if (data === '\u000c') {
        term.clear();
        redraw();
        return;
      }

      // Printable input. Control characters that reach here have no meaning in
      // this mode, so they are dropped rather than inserted as garbage.
      if (data >= ' ' || data === '\t') {
        const printable = data.replace(/[\x00-\x1f\x7f]/g, '');
        if (!printable) return;
        lineRef.current =
          lineRef.current.slice(0, cursorRef.current) + printable + lineRef.current.slice(cursorRef.current);
        cursorRef.current += printable.length;
        redraw();
      }
    });

    return () => disposable.dispose();
  }, [mode, prompt, redraw, write]);

  /* ---------------------------------------------------------- handle */

  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        termRef.current?.clear();
        transcriptRef.current = '';
        if (mode === 'kairos_shell') redraw();
      },
      focus: () => termRef.current?.focus(),
      reconnect: () => {
        socketRef.current?.close(1000, 'reconnecting');
        setGeneration((value) => value + 1);
      },
      transcript: () => transcriptRef.current,
      sendConfirmed: (line, confirm) => {
        const socket = socketRef.current;
        if (socket?.readyState !== WebSocket.OPEN) return;
        write(`${line}
`);
        busyRef.current = true;
        lastCommandRef.current = line;
        socket.send(JSON.stringify({ type: 'command', line, confirm }));
      },
    }),
    [mode, redraw, write],
  );

  return <div ref={hostRef} className={`h-full w-full ${className}`} />;
});
