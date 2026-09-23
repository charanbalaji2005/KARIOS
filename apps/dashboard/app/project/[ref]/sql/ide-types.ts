export interface TableSummary {
  oid?: number;
  schema_name: string;
  table_name: string;
  estimated_rows: number;
  size_bytes: number;
  rls_enabled?: boolean;
}

export interface ViewSummary {
  oid?: number;
  schema_name: string;
  view_name: string;
  definition: string;
}

/**
 * Materialized views are a separate shape, not a ViewSummary.
 *
 * The catalog query aliases `c.relname` to `matview_name` for relkind 'm' and
 * to `view_name` for relkind 'v'. Typing both as ViewSummary compiled fine and
 * produced `undefined` at runtime on every field read.
 */
export interface MaterializedViewSummary {
  oid?: number;
  schema_name: string;
  matview_name: string;
  definition: string;
}

export interface ColumnMetadata {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  ordinal_position: number;
  is_primary_key: boolean;
  foreign_table: string | null;
  foreign_column: string | null;
}

export interface FunctionMetadata {
  oid?: number;
  schema_name: string;
  function_name: string;
  return_type: string;
  arguments: string;
  language?: string;
  is_security_definer?: boolean;
}

export interface TriggerMetadata {
  schema_name: string;
  table_name: string;
  trigger_name: string;
  action_timing: string;
  event_manipulation: string;
}

export interface IndexMetadata {
  schema_name: string;
  tablename: string;
  index_name: string;
  definition: string;
}

export interface ExtensionMetadata {
  oid?: number;
  extension_name: string;
  version: string;
  schema_name: string;
}

export interface EnumMetadata {
  schema_name: string;
  enum_name: string;
  values: string[];
}

export interface SequenceMetadata {
  sequence_schema: string;
  sequence_name: string;
  data_type: string;
}

export interface SchemaCatalog {
  database: string;
  schema: string;
  tables: TableSummary[];
  views: ViewSummary[];
  materializedViews: MaterializedViewSummary[];
  functions: FunctionMetadata[];
  indexes: IndexMetadata[];
  columns: ColumnMetadata[];
  triggers: TriggerMetadata[];
  sequences: SequenceMetadata[];
  enums: EnumMetadata[];
  extensions: ExtensionMetadata[];
}

export interface ExecutionMeta {
  executionTimeMs: number;
  totalDurationMs: number;
  serverTimeMs: number;
  queryHash: string;
  requestId: string;
  statements?: number;
}

export interface ExecuteResult {
  data: Record<string, unknown>[];
  columns: { name: string; dataTypeId?: number }[];
  rowCount: number;
  rowsAffected: number;
  command: string;
  meta: ExecutionMeta;
  error?: string | null;
}

export interface ExplainFinding {
  severity: 'warn' | 'info';
  message: string;
}

export interface ExplainResult {
  plan: Record<string, unknown>;
  planningTimeMs: number | null;
  executionTimeMs: number | null;
  analyzed: boolean;
  findings: ExplainFinding[];
}

export interface QueryTab {
  id: string;
  title: string;
  sql: string;
  parameters: Record<string, string>;
  variables: Record<string, string>;
  result: ExecuteResult | null;
  planResult: ExplainResult | null;
  error: { message: string; line?: number; column?: number; hint?: string } | null;
  isPinned?: boolean;
  isDirty?: boolean;
}

export interface ActiveConnection {
  pid: number;
  usename: string;
  client_addr: string;
  state: string;
  query: string;
  duration_seconds: number;
  wait_event_type: string | null;
  wait_event: string | null;
}

export interface BlockedLock {
  blocked_pid: number;
  blocking_pid: number;
  blocked_statement: string;
  blocking_statement: string;
}

export interface TableStat {
  table_name: string;
  live_rows: number;
  dead_rows: number;
  total_bytes: number;
  table_bytes: number;
  index_bytes: number;
}

export interface SlowQuery {
  id: number;
  query: string;
  duration_ms: number;
  row_count: number;
  created_at: string;
}

export interface DiagnosticsData {
  connections: ActiveConnection[];
  locks: BlockedLock[];
  cacheHitRatio: number;
  commits: number;
  rollbacks: number;
  tables: TableStat[];
  slowQueries: SlowQuery[];
}

export interface SavedQuery {
  id: string;
  title: string;
  category: 'Analytics' | 'Development' | 'Maintenance' | 'Custom';
  sql: string;
  description?: string;
  tags?: string[];
  createdAt: string;
}
