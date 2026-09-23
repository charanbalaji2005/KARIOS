/**
 * The operation registry.
 *
 * This is the allowlist. Requests name an operation *id* — `database_status`,
 * `service_restart` — and the registry maps that id to a function. There is no
 * endpoint anywhere in this agent that accepts a command to run; the set of
 * things the agent can do is fixed at compile time and enumerable at runtime,
 * which is what makes `GET /agent/operations` a meaningful thing to audit.
 */
import type { ArgSchema, ParsedArgs } from './validate.js';

export type OperationCategory =
  | 'system'
  | 'services'
  | 'database'
  | 'storage'
  | 'network'
  | 'firewall'
  | 'docker'
  | 'backup'
  | 'logs'
  | 'provision'
  | 'power';

export interface OperationContext {
  args: ParsedArgs;
  /** Write text to the caller as it is produced. Buffered into the response for non-streaming callers. */
  emit(text: string): void;
  /** Aborted when the caller disconnects or the operation times out. */
  signal: AbortSignal;
}

export interface OperationResult {
  /** Structured result, for the dashboard. */
  data?: unknown;
  /** Human-readable result, for the terminal. */
  text?: string;
  exitCode?: number;
}

export interface Operation {
  id: string;
  summary: string;
  category: OperationCategory;
  /**
   * Dangerous operations affect the whole server or destroy data. The API
   * requires a typed confirmation before forwarding one, and the agent
   * independently requires the `confirm` argument to match — belt and braces,
   * because "the UI asks first" is not a control the agent can verify.
   */
  danger: boolean;
  /** The exact phrase the operator must type. Only meaningful when danger is true. */
  confirmPhrase?: string;
  /** Whether output streams (logs) or arrives at the end (status). */
  streaming?: boolean;
  timeoutMs: number;
  args?: ArgSchema;
  run(context: OperationContext): Promise<OperationResult>;
}

const registry = new Map<string, Operation>();

export function register(...operations: Operation[]): void {
  for (const operation of operations) {
    if (registry.has(operation.id)) {
      // A duplicate id would silently shadow one of the two definitions, and
      // the one that loses could be the more restrictive.
      throw new Error(`Duplicate operation id: ${operation.id}`);
    }
    if (operation.danger && !operation.confirmPhrase) {
      throw new Error(`Dangerous operation ${operation.id} must declare a confirmPhrase`);
    }
    registry.set(operation.id, operation);
  }
}

export function getOperation(id: string): Operation | undefined {
  return registry.get(id);
}

export function listOperations(): Operation[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Serialisable description of the allowlist, for the dashboard and for audit. */
export function describeOperations() {
  return listOperations().map((operation) => ({
    id: operation.id,
    summary: operation.summary,
    category: operation.category,
    danger: operation.danger,
    confirmPhrase: operation.confirmPhrase ?? null,
    streaming: operation.streaming ?? false,
    args: Object.entries(operation.args ?? {}).map(([name, spec]) => ({
      name,
      type: spec.type,
      required: spec.required ?? false,
      values: spec.type === 'enum' ? spec.values : undefined,
      describe: spec.describe,
    })),
  }));
}
