import { ApiError } from './errors.js';

/**
 * DDL cannot be parameterised — you cannot bind a table name. So every identifier
 * that reaches a CREATE/ALTER statement goes through here first: validated against
 * a conservative charset, then double-quoted with internal quotes doubled.
 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_IDENT_LEN = 63; // Postgres NAMEDATALEN - 1

export function quoteIdent(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_IDENT_LEN) {
    throw new ApiError('VALIDATION_ERROR', `Invalid identifier: ${String(name).slice(0, 64)}`);
  }
  if (!IDENT_RE.test(name)) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `"${name}" is not a valid name. Use letters, numbers and underscores, starting with a letter or underscore.`,
    );
  }
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteQualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** Literal quoting for the rare spots where a value must be inlined (e.g. DEFAULT clauses). */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Types are an allow-list rather than a regex: a user should never be able to
 * smuggle an expression through the type slot of an ALTER TABLE.
 */
const BASE_TYPES = new Set([
  'uuid', 'text', 'varchar', 'char', 'integer', 'bigint', 'smallint', 'serial', 'bigserial',
  'numeric', 'decimal', 'real', 'double precision', 'boolean', 'date', 'time', 'timetz',
  'timestamp', 'timestamptz', 'interval', 'json', 'jsonb', 'bytea', 'inet', 'cidr', 'macaddr',
  'tsvector', 'vector', 'citext', 'point', 'money',
]);

export function normalizeType(raw: string): string {
  const input = raw.trim().toLowerCase();

  // Arrays: "text[]" -> base type + suffix
  const arrayMatch = input.match(/^(.+?)(\s*\[\s*\])+$/);
  if (arrayMatch?.[1]) return `${normalizeType(arrayMatch[1])}[]`;

  // Parameterised types: varchar(255), numeric(12,2), vector(1536)
  const paramMatch = input.match(/^([a-z ]+)\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/);
  if (paramMatch) {
    const [, base, a, b] = paramMatch;
    if (!base || !BASE_TYPES.has(base.trim())) {
      throw new ApiError('VALIDATION_ERROR', `Unsupported column type: ${raw}`);
    }
    return b ? `${base.trim()}(${a},${b})` : `${base.trim()}(${a})`;
  }

  if (!BASE_TYPES.has(input)) {
    throw new ApiError('VALIDATION_ERROR', `Unsupported column type: ${raw}`);
  }
  return input;
}

/**
 * Defaults are the one place users legitimately need expressions
 * (now(), gen_random_uuid()). Allow a small set of calls plus plain literals.
 */
const SAFE_DEFAULT_FUNCS = /^(now\(\)|current_timestamp|current_date|gen_random_uuid\(\)|uuid_generate_v4\(\)|true|false|null|-?\d+(\.\d+)?)$/i;

export function normalizeDefault(raw: string): string {
  const input = raw.trim();
  if (SAFE_DEFAULT_FUNCS.test(input)) return input;
  if (/^'[^']*'(::[a-z ]+(\[\])?)?$/i.test(input)) return input; // already a quoted literal
  return quoteLiteral(input);
}

/** Statement classification for the SQL runner's privilege checks. */
export type StatementKind = 'read' | 'write' | 'ddl' | 'destructive' | 'admin';

export function classifyStatement(sql: string): StatementKind {
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ').trim().toLowerCase();
  if (/^\s*(drop|truncate)\b/.test(s)) return 'destructive';
  if (/^\s*(create|alter|comment|grant|revoke)\b/.test(s)) return 'ddl';
  if (/^\s*(insert|update|delete|upsert|copy|merge)\b/.test(s)) return 'write';
  if (/^\s*(select|with|explain|show|table|values)\b/.test(s)) return 'read';
  return 'admin';
}
