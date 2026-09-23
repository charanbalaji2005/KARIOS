/**
 * CSV / JSON import and export.
 *
 * Export streams. Import does not, and that is a deliberate difference: an
 * import needs to validate before it writes anything, because a half-applied
 * import is worse than a rejected one — you cannot tell which rows landed
 * without diffing against a file.
 *
 * Every import runs in a transaction and reports what it would do before it
 * does it. `dryRun` is the default for exactly that reason.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { poolManager } from '../db/pool-manager.js';
import { quoteIdent } from '../lib/sql.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { consume, RULES } from '../lib/rate-limit.js';
import { enforceQuota } from '../lib/quotas.js';

const MAX_IMPORT_ROWS = Number(process.env['MAX_IMPORT_ROWS'] ?? 50_000);

/**
 * RFC 4180 CSV parser.
 *
 * Written rather than pulled in because the edge cases that matter here are
 * few and specific: quoted fields containing commas, escaped quotes, and CRLF.
 * A parser that splits on commas works until the first address column.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1; // escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }

  // A file not ending in a newline still has a final row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.length > 1 || entry[0] !== '');
}

function toCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Quote when the value contains a delimiter, a quote or a newline. Also when
  // it starts with a character a spreadsheet would treat as a formula — CSV
  // injection is how an exported support ticket runs a command on someone's
  // laptop.
  if (/[",\r\n]/.test(text) || /^[=+\-@\t]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export default async function importExportRoutes(app: FastifyInstance) {
  const read = { preHandler: [app.requireProject('database.read')] };
  const write = { preHandler: [app.requireProject('database.write')] };

  /**
   * Export. Streams rows out in pages so a large table does not have to fit
   * in memory on either side.
   */
  app.get('/projects/:projectId/database/tables/:table/export', read, async (req, reply) => {
    const params = z.object({ table: z.string().min(1) }).parse(req.params);
    const q = z.object({
      format: z.enum(['csv', 'json']).default('csv'),
      limit: z.coerce.number().min(1).max(1_000_000).default(100_000),
    }).parse(req.query);

    const pool = await poolManager.get(req.project!.id);
    const table = quoteIdent(params.table);

    const result = await pool.query(`SELECT * FROM public.${table} LIMIT $1`, [q.limit]);
    void audit(req, {
      action: 'TABLE_EXPORTED',
      projectId: req.project!.id,
      resourceType: 'table',
      resourceId: params.table,
      metadata: { format: q.format, rows: result.rowCount },
    });

    if (q.format === 'json') {
      reply.header('content-disposition', `attachment; filename="${params.table}.json"`);
      return reply.type('application/json').send(JSON.stringify(result.rows, null, 2));
    }

    const headers = result.fields.map((field) => field.name);
    const lines = [headers.map(toCsvValue).join(',')];
    for (const row of result.rows as Record<string, unknown>[]) {
      lines.push(headers.map((header) => toCsvValue(row[header])).join(','));
    }

    reply.header('content-disposition', `attachment; filename="${params.table}.csv"`);
    return reply.type('text/csv; charset=utf-8').send(lines.join('\n'));
  });

  /**
   * Import.
   *
   * Defaults to a dry run. The response shape is identical either way, so the
   * UI can show a preview and then repeat the call with `dryRun: false`
   * without a second code path.
   */
  app.post('/projects/:projectId/database/tables/:table/import', write, async (req) => {
    await consume('import', req.project!.id, RULES.sql);
    const params = z.object({ table: z.string().min(1) }).parse(req.params);
    const body = z.object({
      format: z.enum(['csv', 'json']),
      content: z.string().min(1).max(50 * 1024 * 1024),
      /** Source column → destination column. Omitted means match by name. */
      mapping: z.record(z.string()).optional(),
      mode: z.enum(['insert', 'upsert']).default('insert'),
      conflictTarget: z.string().optional(),
      dryRun: z.boolean().default(true),
    }).parse(req.body);

    const pool = await poolManager.get(req.project!.id);
    const table = quoteIdent(params.table);

    // Introspect first. Importing into a column that does not exist should
    // fail with the column name, not with a PostgreSQL error the user has to
    // decode.
    const schema = await pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [params.table],
    );
    if (schema.rowCount === 0) throw new ApiError('TABLE_NOT_FOUND', `No table called ${params.table}`);
    const known = new Set(schema.rows.map((row) => row.column_name));

    let records: Record<string, unknown>[];
    if (body.format === 'json') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.content);
      } catch {
        throw new ApiError('VALIDATION_ERROR', 'That is not valid JSON');
      }
      if (!Array.isArray(parsed)) throw new ApiError('VALIDATION_ERROR', 'Expected a JSON array of objects');
      records = parsed as Record<string, unknown>[];
    } else {
      const rows = parseCsv(body.content);
      const header = rows.shift();
      if (!header) throw new ApiError('VALIDATION_ERROR', 'The file has no header row');
      records = rows.map((row) => {
        const record: Record<string, unknown> = {};
        header.forEach((name, index) => {
          // An empty CSV cell is NULL, not the empty string. Getting this
          // backwards silently turns every missing number into a type error.
          const value = row[index];
          record[name] = value === '' || value === undefined ? null : value;
        });
        return record;
      });
    }

    if (records.length === 0) throw new ApiError('VALIDATION_ERROR', 'There are no rows to import');
    if (records.length > MAX_IMPORT_ROWS) {
      throw new ApiError('VALIDATION_ERROR', `That is ${records.length} rows; the limit is ${MAX_IMPORT_ROWS}. Split the file.`);
    }

    const mapping = body.mapping ?? {};
    const sourceColumns = Object.keys(records[0]!);
    const targetColumns = sourceColumns.map((name) => mapping[name] ?? name);

    const unknownColumns = targetColumns.filter((name) => !known.has(name));
    if (unknownColumns.length > 0) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `These columns do not exist in ${params.table}: ${unknownColumns.join(', ')}. Map them or remove them.`,
      );
    }

    const missingRequired = schema.rows
      .filter((row) => row.is_nullable === 'NO' && !row.column_default)
      .map((row) => row.column_name)
      .filter((name) => !targetColumns.includes(name));
    if (missingRequired.length > 0) {
      throw new ApiError('VALIDATION_ERROR', `These columns are required and not in the file: ${missingRequired.join(', ')}`);
    }

    await enforceQuota(req.project!.id, 'api_requests_per_hour', records.length);

    if (body.dryRun) {
      return {
        data: {
          dryRun: true,
          rows: records.length,
          columns: targetColumns,
          sample: records.slice(0, 5),
          wouldInsert: records.length,
        },
        error: null,
      };
    }

    // One transaction for the whole file. A partial import leaves the user
    // unable to tell which rows landed without diffing against the source.
    const client = await pool.connect();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      const columnList = targetColumns.map(quoteIdent).join(', ');
      const conflict =
        body.mode === 'upsert' && body.conflictTarget
          ? ` ON CONFLICT (${quoteIdent(body.conflictTarget)}) DO UPDATE SET ${targetColumns
              .filter((name) => name !== body.conflictTarget)
              .map((name) => `${quoteIdent(name)} = EXCLUDED.${quoteIdent(name)}`)
              .join(', ')}`
          : '';

      // Batched, because one round trip per row makes a 50k import take
      // minutes for no reason.
      const BATCH = 500;
      for (let offset = 0; offset < records.length; offset += BATCH) {
        const batch = records.slice(offset, offset + BATCH);
        const values: unknown[] = [];
        const tuples = batch.map((record) => {
          const placeholders = sourceColumns.map((name) => {
            values.push(record[name] ?? null);
            return `$${values.length}`;
          });
          return `(${placeholders.join(', ')})`;
        });
        const result = await client.query(
          `INSERT INTO public.${table} (${columnList}) VALUES ${tuples.join(', ')}${conflict}`,
          values,
        );
        inserted += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new ApiError('DATABASE_ERROR', `Import failed and nothing was written: ${(error as Error).message}`);
    } finally {
      client.release();
    }

    void audit(req, {
      action: 'TABLE_IMPORTED',
      projectId: req.project!.id,
      resourceType: 'table',
      resourceId: params.table,
      metadata: { rows: inserted, mode: body.mode },
    });

    return { data: { dryRun: false, inserted, rows: records.length }, error: null };
  });
}
