/**
 * @kairosdb/client — the SDK a developer installs in their own app.
 *
 * createClient(url, anonKey).from('posts').select('*').eq('published', true)
 */

export interface KairosResponse<T> {
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
  count?: number;
}

export interface ClientOptions {
  /** Token representing the signed-in end user; sent alongside the anon key. */
  accessToken?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

type Filter = [column: string, operator: string, value: unknown];

class QueryBuilder<Row = Record<string, unknown>> implements PromiseLike<KairosResponse<Row[]>> {
  private filters: Filter[] = [];
  private columns = '*';
  private ordering: string[] = [];
  private limitValue?: number;
  private offsetValue?: number;
  private countMode?: 'exact';
  private method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET';
  private payload?: unknown;
  private singleRow = false;
  private maybe = false;

  constructor(
    private readonly table: string,
    private readonly request: (path: string, init: RequestInit) => Promise<KairosResponse<unknown>>,
  ) {}

  select(columns = '*'): this { this.columns = columns; return this; }
  insert(values: Partial<Row> | Partial<Row>[]): this { this.method = 'POST'; this.payload = values; return this; }
  update(values: Partial<Row>): this { this.method = 'PATCH'; this.payload = values; return this; }
  delete(): this { this.method = 'DELETE'; return this; }

  eq(column: string, value: unknown): this { return this.filter(column, 'eq', value); }
  neq(column: string, value: unknown): this { return this.filter(column, 'neq', value); }
  gt(column: string, value: unknown): this { return this.filter(column, 'gt', value); }
  gte(column: string, value: unknown): this { return this.filter(column, 'gte', value); }
  lt(column: string, value: unknown): this { return this.filter(column, 'lt', value); }
  lte(column: string, value: unknown): this { return this.filter(column, 'lte', value); }
  like(column: string, pattern: string): this { return this.filter(column, 'like', pattern); }
  ilike(column: string, pattern: string): this { return this.filter(column, 'ilike', pattern); }
  is(column: string, value: null | boolean): this { return this.filter(column, 'is', value === null ? 'null' : String(value)); }
  in(column: string, values: unknown[]): this { return this.filter(column, 'in', `(${values.join(',')})`); }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    const parts = [column, options.ascending === false ? 'desc' : 'asc'];
    if (options.nullsFirst !== undefined) parts.push(options.nullsFirst ? 'nullsfirst' : 'nullslast');
    this.ordering.push(parts.join('.'));
    return this;
  }

  limit(count: number): this { this.limitValue = count; return this; }
  range(from: number, to: number): this { this.offsetValue = from; this.limitValue = to - from + 1; return this; }
  count(): this { this.countMode = 'exact'; return this; }
  single(): this { this.singleRow = true; return this; }
  maybeSingle(): this { this.singleRow = true; this.maybe = true; return this; }

  private filter(column: string, operator: string, value: unknown): this {
    this.filters.push([column, operator, value]);
    return this;
  }

  private buildQueryString(): string {
    const params = new URLSearchParams();
    if (this.method === 'GET') {
      if (this.columns !== '*') params.set('select', this.columns);
      if (this.ordering.length) params.set('order', this.ordering.join(','));
      if (this.limitValue !== undefined) params.set('limit', String(this.limitValue));
      if (this.offsetValue !== undefined) params.set('offset', String(this.offsetValue));
      if (this.countMode) params.set('count', this.countMode);
    }
    for (const [column, operator, value] of this.filters) {
      params.append(column, `${operator}.${String(value)}`);
    }
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }

  /** Awaiting the builder is what actually sends the request. */
  async then<TResult1 = KairosResponse<Row[]>, TResult2 = never>(
    onfulfilled?: ((value: KairosResponse<Row[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const run = async (): Promise<KairosResponse<Row[]>> => {
      const init: RequestInit = { method: this.method };
      if (this.payload !== undefined) init.body = JSON.stringify(this.payload);

      const result = (await this.request(
        `/rest/v1/${encodeURIComponent(this.table)}${this.buildQueryString()}`,
        init,
      )) as KairosResponse<Row[]>;

      if (result.error || !this.singleRow) return result;

      const rows = result.data ?? [];
      if (rows.length === 1) return { ...result, data: [rows[0]!] };
      if (rows.length === 0 && this.maybe) return { ...result, data: [] };
      return {
        data: null,
        error: { code: 'VALIDATION_ERROR', message: `Expected exactly one row, received ${rows.length}` },
      };
    };

    return run().then(onfulfilled, onrejected);
  }
}

class AuthClient {
  constructor(private readonly base: string, private readonly key: string, private readonly fetchImpl: typeof fetch) {}

  private async call(path: string, body: unknown): Promise<KairosResponse<unknown>> {
    const response = await this.fetchImpl(`${this.base}/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: this.key },
      body: JSON.stringify(body),
    });
    return (await response.json()) as KairosResponse<unknown>;
  }

  signUp(credentials: { email: string; password: string; fullName?: string }) { return this.call('/auth/signup', credentials); }
  signIn(credentials: { email: string; password: string }) { return this.call('/auth/login', credentials); }
  signOut(refreshToken?: string) { return this.call('/auth/logout', { refreshToken }); }
  refreshSession(refreshToken: string) { return this.call('/auth/refresh', { refreshToken }); }
  resetPassword(email: string) { return this.call('/auth/password/forgot', { email }); }
}

class StorageBucketClient {
  constructor(
    private readonly base: string,
    private readonly projectPath: string,
    private readonly bucket: string,
    private readonly headers: () => Record<string, string>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async upload(path: string, file: Blob | File): Promise<KairosResponse<unknown>> {
    const form = new FormData();
    form.append('path', path);
    form.append('file', file);
    const response = await this.fetchImpl(`${this.base}${this.projectPath}/storage/buckets/${this.bucket}/upload`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });
    return (await response.json()) as KairosResponse<unknown>;
  }

  async createSignedUrl(path: string, expiresIn = 3600): Promise<KairosResponse<{ url: string }>> {
    const response = await this.fetchImpl(`${this.base}${this.projectPath}/storage/buckets/${this.bucket}/signed-url`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ path, expiresIn }),
    });
    return (await response.json()) as KairosResponse<{ url: string }>;
  }

  getPublicUrl(projectRef: string, path: string): string {
    return `${this.base}/storage/v1/public/${projectRef}/${this.bucket}/${path}`;
  }

  async remove(path: string): Promise<KairosResponse<unknown>> {
    const response = await this.fetchImpl(`${this.base}${this.projectPath}/storage/buckets/${this.bucket}/objects`, {
      method: 'DELETE',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    return (await response.json()) as KairosResponse<unknown>;
  }
}

export interface ChangePayload {
  schema: string;
  table: string;
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

export interface ChangeFilter {
  /** '*' for every event, or a specific one. */
  event?: 'INSERT' | 'UPDATE' | 'DELETE' | '*';
  schema?: string;
  table?: string;
}

interface Binding {
  filter: ChangeFilter;
  handler: (payload: ChangePayload) => void;
}

class RealtimeChannel {
  private socket?: WebSocket;
  private bindings: Binding[] = [];
  private reconnectDelay = 1000;
  private closed = false;
  private subscribed = false;

  constructor(
    private readonly url: string,
    private readonly table: string,
    private readonly schema: string,
  ) {}

  /**
   * Register a handler.
   *
   * The documented form takes a filter as the second argument:
   *
   *   channel.on('postgres_changes', { event: '*', table: 'profiles' }, cb)
   *
   * The two-argument form the SDK previously implemented is still accepted, so
   * existing code keeps working — the README and the implementation had
   * drifted apart, and breaking the code to match the docs would be the wrong
   * half to fix.
   */
  on(event: 'postgres_changes', handler: (payload: ChangePayload) => void): this;
  on(event: 'postgres_changes', filter: ChangeFilter, handler: (payload: ChangePayload) => void): this;
  on(
    _event: 'postgres_changes',
    filterOrHandler: ChangeFilter | ((payload: ChangePayload) => void),
    maybeHandler?: (payload: ChangePayload) => void,
  ): this {
    const handler = typeof filterOrHandler === 'function' ? filterOrHandler : maybeHandler;
    const filter = typeof filterOrHandler === 'function' ? {} : filterOrHandler;
    if (!handler) throw new TypeError('on() needs a handler function');
    this.bindings.push({ filter, handler });
    return this;
  }

  /**
   * @param callback optional status callback, called with 'SUBSCRIBED' once
   * the server confirms, and 'CLOSED' when the socket goes away.
   */
  subscribe(callback?: (status: 'SUBSCRIBED' | 'CLOSED' | 'ERROR') => void): this {
    this.statusCallback = callback;
    this.connect();
    return this;
  }

  private statusCallback?: (status: 'SUBSCRIBED' | 'CLOSED' | 'ERROR') => void;

  /** Does this event match a binding's filter? */
  private matches(filter: ChangeFilter, frame: ChangePayload): boolean {
    if (filter.event && filter.event !== '*' && filter.event !== frame.type) return false;
    if (filter.table && filter.table !== frame.table) return false;
    if (filter.schema && filter.schema !== (frame.schema ?? 'public')) return false;
    return true;
  }

  private connect(): void {
    this.socket = new WebSocket(this.url);

    this.socket.addEventListener('open', () => {
      this.reconnectDelay = 1000;
      this.socket?.send(JSON.stringify({ type: 'subscribe', schema: this.schema, table: this.table }));
    });

    this.socket.addEventListener('message', (event) => {
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.type === 'subscribed') {
          this.subscribed = true;
          this.statusCallback?.('SUBSCRIBED');
          return;
        }
        if (frame.type === 'error') {
          this.statusCallback?.('ERROR');
          return;
        }
        if (frame.type === 'change') {
          const payload = frame as ChangePayload;
          for (const binding of this.bindings) {
            if (this.matches(binding.filter, payload)) binding.handler(payload);
          }
        }
      } catch {
        /* ignore malformed frames */
      }
    });

    // Reconnect with backoff, because a dropped socket should not silently
    // stop delivering changes.
    this.socket.addEventListener('close', () => {
      this.subscribed = false;
      this.statusCallback?.('CLOSED');
      if (this.closed) return;
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    });
  }

  unsubscribe(): void {
    this.closed = true;
    this.socket?.close();
  }
}

export class KairosClient {
  readonly auth: AuthClient;
  private accessToken?: string;

  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly options: ClientOptions = {},
  ) {
    this.accessToken = options.accessToken;
    this.auth = new AuthClient(url, key, options.fetch ?? fetch);
  }

  setAuth(token: string | undefined): void {
    this.accessToken = token;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { apikey: this.key, ...this.options.headers };
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    return headers;
  }

  private async request(path: string, init: RequestInit): Promise<KairosResponse<unknown>> {
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(`${this.url}${path}`, {
      ...init,
      headers: { ...this.headers(), 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    });

    if (response.status === 204) return { data: null, error: null };
    const body = (await response.json().catch(() => null)) as KairosResponse<unknown> | null;
    if (!body) {
      return { data: null, error: { code: 'INTERNAL_ERROR', message: `Unreadable response (${response.status})` } };
    }
    return body;
  }

  from<Row = Record<string, unknown>>(table: string): QueryBuilder<Row> {
    return new QueryBuilder<Row>(table, (path, init) => this.request(path, init));
  }

  storage = {
    from: (bucket: string, projectId: string) =>
      new StorageBucketClient(this.url, `/api/v1/projects/${projectId}`, bucket, () => this.headers(), this.options.fetch ?? fetch),
  };

  channel(table: string, options: { schema?: string } = {}): RealtimeChannel {
    const wsBase = this.url.replace(/^http/, 'ws');
    const params = new URLSearchParams({ apikey: this.key });
    if (this.accessToken) params.set('token', this.accessToken);
    return new RealtimeChannel(`${wsBase}/realtime/v1?${params}`, table, options.schema ?? 'public');
  }
}

export function createClient(url: string, key: string, options: ClientOptions = {}): KairosClient {
  if (!url) throw new Error('createClient needs your project URL');
  if (!key) throw new Error('createClient needs an API key');
  return new KairosClient(url.replace(/\/$/, ''), key, options);
}

export type { QueryBuilder, RealtimeChannel };
