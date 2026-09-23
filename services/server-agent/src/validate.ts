/**
 * Argument validation.
 *
 * Operations declare the arguments they accept and the exact shape of each.
 * There is no pass-through: a key the operation did not declare is a rejected
 * request, not an ignored one. That distinction matters — silently dropping an
 * unknown key is how a typo in `unit` becomes "restart the default unit".
 *
 * `enum` is the type most arguments use, and that is the point. An operation
 * that restarts a service takes one of seven known unit names, not a string.
 */

export type ArgSpec =
  | { type: 'enum'; values: readonly string[]; required?: boolean; default?: string; describe?: string }
  | { type: 'string'; pattern: RegExp; maxLength: number; required?: boolean; default?: string; describe?: string }
  | { type: 'int'; min: number; max: number; required?: boolean; default?: number; describe?: string }
  | { type: 'boolean'; required?: boolean; default?: boolean; describe?: string };

export type ArgSchema = Record<string, ArgSpec>;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Infer a usable value type from the schema without demanding generics at every call site. */
export type ParsedArgs = Record<string, string | number | boolean>;

export function parseArgs(schema: ArgSchema | undefined, raw: unknown): ParsedArgs {
  const input: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  if (!schema) {
    const extra = Object.keys(input);
    if (extra.length > 0) throw new ValidationError(`This operation takes no arguments (got: ${extra.join(', ')})`);
    return {};
  }

  // `hasOwnProperty`, not `in`: `in` walks the prototype chain, so
  // `{"constructor": "..."}` would pass an `in schema` check and defeat the
  // point of rejecting unknown keys.
  const declared = (key: string) => Object.prototype.hasOwnProperty.call(schema, key);

  for (const key of Object.keys(input)) {
    if (!declared(key)) {
      throw new ValidationError(`Unknown argument "${key}". Accepted: ${Object.keys(schema).join(', ') || 'none'}`);
    }
  }

  const output: ParsedArgs = {};
  for (const [key, spec] of Object.entries(schema)) {
    const present =
      Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined && input[key] !== null;

    if (!present) {
      if (spec.required) throw new ValidationError(`Missing required argument "${key}"`);
      if (spec.default !== undefined) output[key] = spec.default;
      continue;
    }

    const value = input[key];

    switch (spec.type) {
      case 'enum': {
        if (typeof value !== 'string' || !spec.values.includes(value)) {
          throw new ValidationError(`"${key}" must be one of: ${spec.values.join(', ')}`);
        }
        output[key] = value;
        break;
      }
      case 'string': {
        if (typeof value !== 'string') throw new ValidationError(`"${key}" must be a string`);
        if (value.length > spec.maxLength) {
          throw new ValidationError(`"${key}" must be at most ${spec.maxLength} characters`);
        }
        if (!spec.pattern.test(value)) {
          throw new ValidationError(`"${key}" contains characters that are not allowed here`);
        }
        output[key] = value;
        break;
      }
      case 'int': {
        const parsed = typeof value === 'number' ? value : Number(value);
        if (!Number.isInteger(parsed)) throw new ValidationError(`"${key}" must be a whole number`);
        if (parsed < spec.min || parsed > spec.max) {
          throw new ValidationError(`"${key}" must be between ${spec.min} and ${spec.max}`);
        }
        output[key] = parsed;
        break;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') throw new ValidationError(`"${key}" must be true or false`);
        output[key] = value;
        break;
      }
    }
  }

  return output;
}

/* --------------------------------------------------------- common patterns */

/**
 * Patterns shared across operations.
 *
 * Note what is missing from every one of them: `/`, `.`, `..`, whitespace and
 * shell metacharacters. Path traversal is prevented by never accepting a path
 * in the first place — operations take an identifier and resolve it against a
 * table, rather than accepting a path and trying to sanitise it.
 */
export const PATTERNS = {
  /** A systemd unit or docker container name. No slashes, no dots-dot. */
  identifier: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/,
  /**
   * A backup id: the timestamped archive name the agent writes, e.g.
   * `kairos-platform-20260923T101500Z.dump`.
   *
   * Dots are allowed only between segments, so `..` cannot appear and there is
   * no `/` to combine it with anyway. `resolveBackup` re-proves containment
   * against the backup directory regardless.
   */
  backupId: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,96}(\.[a-zA-Z0-9_-]{1,16})*$/,
  /** Free text for a confirmation phrase or a reason. */
  phrase: /^[A-Za-z0-9 _.,:'()-]{1,200}$/,
  /** A CIDR or bare address, for firewall rules that accept a source. */
  cidr: /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/,
} as const;
