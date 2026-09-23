/** Shared shapes used by the API, the dashboard and the CLI. */

export type Role = 'owner' | 'admin' | 'developer' | 'viewer';
export type ProjectStatus = 'provisioning' | 'active' | 'paused' | 'failed' | 'deleting';

export interface ApiEnvelope<T> {
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
  meta?: Record<string, unknown>;
}

export interface Project {
  id: string;
  ref: string;
  name: string;
  status: ProjectStatus;
  region: string;
  organization_id: string;
  created_at: string;
  role?: Role;
}

export interface TableSummary {
  name: string;
  schema: string;
  rls_enabled: boolean;
  comment: string | null;
  estimated_rows: number;
  size_bytes: number;
  column_count: number;
}

export interface ColumnDetail {
  name: string;
  type: string;
  nullable: boolean;
  default_value: string | null;
  position: number;
  comment: string | null;
  is_primary_key: boolean;
}

export interface PolicyDetail {
  name: string;
  command: string;
  permissive: string;
  roles: string[];
  using_expression: string | null;
  check_expression: string | null;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  kind: 'anon' | 'service_role' | 'secret';
  prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
