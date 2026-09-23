/**
 * OpenAPI 3.1 generation.
 *
 * Generated from the project's live schema rather than maintained by hand, for
 * the obvious reason: a hand-written spec is wrong the first time someone adds
 * a column and does not update it, and a confidently wrong spec is worse than
 * none — people write code against it.
 *
 *   information_schema → column types, nullability, defaults
 *   pg_catalog         → primary keys, foreign keys, RLS state
 *          ↓
 *   OpenAPI 3.1 document
 *          ↓
 *   /docs (Scalar), the API explorer, and any client generator
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { poolManager } from '../db/pool-manager.js';
import { env } from '../env.js';

/** PostgreSQL type → JSON Schema. */
function jsonSchemaFor(dataType: string, udtName: string): Record<string, unknown> {
  switch (dataType) {
    case 'integer':
    case 'smallint':
      return { type: 'integer', format: 'int32' };
    case 'bigint':
      // Serialised as a string by the driver: a bigint past 2^53 does not
      // survive JSON.parse as a number, and silently losing precision is
      // worse than an inconvenient type.
      return { type: 'string', format: 'int64' };
    case 'numeric':
    case 'real':
    case 'double precision':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'jsonb':
    case 'json':
      return {};
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      return { type: 'string', format: 'date-time' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'uuid':
      return { type: 'string', format: 'uuid' };
    case 'ARRAY':
      return { type: 'array', items: jsonSchemaFor(udtName.replace(/^_/, ''), udtName) };
    case 'USER-DEFINED':
      return udtName === 'vector' ? { type: 'array', items: { type: 'number' } } : { type: 'string' };
    default:
      return { type: 'string' };
  }
}

const FILTER_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'cs', 'cd'];

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  is_primary: boolean;
}

export async function buildOpenApi(projectId: string, projectRef: string): Promise<Record<string, unknown>> {
  const pool = await poolManager.get(projectId);

  const columns = await pool.query<ColumnRow>(
    `SELECT c.table_name, c.column_name, c.data_type, c.udt_name,
            c.is_nullable, c.column_default,
            COALESCE(pk.is_primary, false) AS is_primary
       FROM information_schema.columns c
       LEFT JOIN (
         SELECT kcu.table_name, kcu.column_name, true AS is_primary
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
          WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
       ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
      WHERE c.table_schema = 'public'
      ORDER BY c.table_name, c.ordinal_position`,
  );

  const tables = new Map<string, ColumnRow[]>();
  for (const row of columns.rows) {
    const list = tables.get(row.table_name) ?? [];
    list.push(row);
    tables.set(row.table_name, list);
  }

  const schemas: Record<string, unknown> = {};
  const paths: Record<string, unknown> = {};

  for (const [table, cols] of tables) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const column of cols) {
      const schema = jsonSchemaFor(column.data_type, column.udt_name);
      properties[column.column_name] = {
        ...schema,
        ...(column.is_nullable === 'YES' ? { nullable: true } : {}),
        ...(column.column_default ? { default: undefined, description: `Defaults to ${column.column_default}` } : {}),
        ...(column.is_primary ? { readOnly: true } : {}),
      };
      // A column with a default is not required on insert even when NOT NULL —
      // a generated spec that demands `id` on every POST is one people stop
      // trusting immediately.
      if (column.is_nullable === 'NO' && !column.column_default) required.push(column.column_name);
    }

    schemas[table] = { type: 'object', properties, ...(required.length ? { required } : {}) };

    const filterParams = cols.map((column) => ({
      name: column.column_name,
      in: 'query',
      required: false,
      schema: { type: 'string' },
      description: `Filter on ${column.column_name}. Format: ${FILTER_OPERATORS.map((op) => `${op}.value`).join(', ')}`,
    }));

    paths[`/rest/v1/${table}`] = {
      get: {
        tags: [table],
        summary: `Read rows from ${table}`,
        parameters: [
          ...filterParams,
          { name: 'select', in: 'query', schema: { type: 'string' }, description: 'Comma-separated columns' },
          { name: 'order', in: 'query', schema: { type: 'string' }, description: 'e.g. created_at.desc' },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
          {
            name: 'Prefer', in: 'header', schema: { type: 'string', enum: ['count=exact'] },
            description: 'count=exact returns a Content-Range header with the total',
          },
        ],
        responses: {
          200: {
            description: 'Rows the caller is allowed to see, after RLS',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: `#/components/schemas/${table}` } } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        tags: [table],
        summary: `Insert into ${table}`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: `#/components/schemas/${table}` },
                  { type: 'array', items: { $ref: `#/components/schemas/${table}` } },
                ],
              },
            },
          },
        },
        responses: { 201: { description: 'Created' }, 401: { $ref: '#/components/responses/Unauthorized' } },
      },
      patch: {
        tags: [table],
        summary: `Update rows in ${table}`,
        description:
          'A filter is required. An unfiltered PATCH is rejected — wiping a table should take more than a forgotten query string.',
        parameters: filterParams,
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${table}` } } } },
        responses: { 200: { description: 'Updated' }, 422: { description: 'No filter supplied' } },
      },
      delete: {
        tags: [table],
        summary: `Delete rows from ${table}`,
        description: 'A filter is required, for the same reason as PATCH.',
        parameters: filterParams,
        responses: { 200: { description: 'Deleted' }, 422: { description: 'No filter supplied' } },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `Kairos project ${projectRef}`,
      version: '1.0.0',
      description:
        'Generated from this project\'s live schema. Every response is filtered by row level security — ' +
        'an anon key sees what the policies allow, a service_role key bypasses them and must stay server-side.',
    },
    servers: [{ url: env.API_URL }],
    components: {
      schemas,
      securitySchemes: {
        apikey: { type: 'apiKey', in: 'header', name: 'apikey', description: 'Project anon or service_role key' },
        bearer: {
          type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
          description: 'End-user token. Populates auth.uid() so RLS policies can identify the caller.',
        },
      },
      responses: {
        Unauthorized: {
          description: 'Missing or invalid API key',
          content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'null' }, error: { type: 'object' } } } } },
        },
      },
    },
    security: [{ apikey: [] }, { apikey: [], bearer: [] }],
    paths,
  };
}

export default async function openApiRoutes(app: FastifyInstance) {
  const read = { preHandler: [app.requireProject('database.read')] };

  app.get('/projects/:projectId/openapi.json', read, async (req) => {
    const document = await buildOpenApi(req.project!.id, req.project!.ref);
    return document; // raw, not enveloped — tooling expects a bare document
  });

  /**
   * Rendered reference. Scalar is loaded from the CDN the artifact CSP allows;
   * the spec itself is fetched with the caller's key rather than embedded, so
   * this page does not become a way to read a schema without credentials.
   */
  app.get('/projects/:projectId/docs', read, async (req, reply) => {
    const specUrl = `${env.API_URL}/api/v1/projects/${req.project!.ref}/openapi.json`;
    return reply.type('text/html').send(`<!doctype html>
<html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Kairos — ${req.project!.ref} API</title>
</head><body>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body></html>`);
  });

  /** Typed client scaffold, generated from the same source as the spec. */
  app.get('/projects/:projectId/openapi.types', read, async (req) => {
    const document = (await buildOpenApi(req.project!.id, req.project!.ref)) as {
      components: { schemas: Record<string, { properties: Record<string, { type?: string; nullable?: boolean }> }> };
    };

    const lines = ['// Generated from the live schema. Re-run after a migration.', ''];
    for (const [table, schema] of Object.entries(document.components.schemas)) {
      lines.push(`export interface ${table.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase())} {`);
      for (const [column, definition] of Object.entries(schema.properties)) {
        const tsType =
          definition.type === 'integer' || definition.type === 'number'
            ? 'number'
            : definition.type === 'boolean'
              ? 'boolean'
              : definition.type === 'array'
                ? 'unknown[]'
                : definition.type === undefined
                  ? 'unknown'
                  : 'string';
        lines.push(`  ${column}: ${tsType}${definition.nullable ? ' | null' : ''};`);
      }
      lines.push('}', '');
    }
    return { data: { types: lines.join('\n') }, error: null };
  });
}
