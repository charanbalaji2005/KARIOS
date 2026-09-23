'use client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * The same origin as a ws:// or wss:// URL, for the server terminal.
 * Derived rather than configured separately, so the two cannot drift apart.
 */
export const WS_URL = API_URL.replace(/^http/, 'ws');

export interface Envelope<T> {
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
  meta?: Record<string, unknown>;
}

const TOKEN_KEY = 'kairos.accessToken';
const USER_KEY = 'kairos.user';

export const session = {
  get: () => (typeof window === 'undefined' ? null : window.localStorage.getItem(TOKEN_KEY)),
  set: (token: string) => window.localStorage.setItem(TOKEN_KEY, token),
  clear: () => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(TOKEN_KEY);
      window.localStorage.removeItem(USER_KEY);
    }
  },
  getUser: (): { email?: string; id?: string } | null => {
    if (typeof window === 'undefined') return null;
    try {
      const u = window.localStorage.getItem(USER_KEY);
      return u ? JSON.parse(u) : null;
    } catch {
      return null;
    }
  },
  setUser: (user: { email?: string; id?: string }) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(USER_KEY, JSON.stringify(user));
    }
  },
};

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly details?: unknown) {
    super(message);
  }
}

/**
 * Single entry point for every call the dashboard makes. Refresh is handled
 * once per failure, transparently, so pages never deal with expiry.
 */
export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const token = session.get();
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string>),
    },
  });

  if (response.status === 401 && retry) {
    const refreshed = await fetch(`${API_URL}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (refreshed.ok) {
      const body = (await refreshed.json()) as Envelope<{ accessToken: string }>;
      if (body.data?.accessToken) {
        session.set(body.data.accessToken);
        return api<T>(path, init, false);
      }
    }
    session.clear();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) throw new ApiError(await response.text(), 'INTERNAL_ERROR');
    return (await response.text()) as T;
  }

  const body = (await response.json()) as Record<string, any>;
  if (!response.ok || (body && body.error)) {
    let msg = 'Request failed';
    let code = 'ERROR';
    if (body?.error && typeof body.error === 'object' && body.error.message) {
      msg = body.error.message;
      code = body.error.code ?? code;
    } else if (typeof body?.message === 'string') {
      msg = body.message;
      try {
        const parsed = JSON.parse(msg);
        if (Array.isArray(parsed) && parsed[0]?.message) {
          msg = parsed.map((item: any) => item.message).join('; ');
        }
      } catch {
        // keep string
      }
      code = body.code ?? code;
    } else if (typeof body?.error === 'string') {
      msg = body.error;
      code = body.code ?? code;
    }
    throw new ApiError(msg, code, body?.error?.details ?? body?.details);
  }

  return (body.data !== undefined ? body.data : body) as T;
}

export const formatBytes = (bytes: number): string => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};
