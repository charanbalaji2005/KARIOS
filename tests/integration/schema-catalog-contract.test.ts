/**
 * The contract between the catalog query and the editor's types.
 *
 * `GET /projects/:id/sql/schema` builds its response from hand-written
 * `pg_catalog` queries, and the SQL editor reads the result through interfaces
 * in `ide-types.ts`. Nothing connects the two: the API aliases a column to
 * `matview_name`, the interface declares `view_name`, TypeScript is satisfied
 * because both are strings on a plausible-looking type, and the editor renders
 * `undefined` — or throws on `undefined.toLowerCase()` in the autocomplete
 * cache, which runs on every keystroke.
 *
 * That has happened twice. This test is the missing link: it reads both files
 * and asserts the names still agree.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const routes = readFileSync(join(repoRoot, 'services/api/src/modules/sql.routes.ts'), 'utf8');
const types = readFileSync(join(repoRoot, 'apps/dashboard/app/project/[ref]/sql/ide-types.ts'), 'utf8');
const editor = readFileSync(join(repoRoot, 'apps/dashboard/app/project/[ref]/sql/page.tsx'), 'utf8');
const cache = readFileSync(join(repoRoot, 'apps/dashboard/app/project/[ref]/sql/ide-schema-cache.ts'), 'utf8');

/** Field names declared on a named TypeScript interface. */
function interfaceFields(source: string, name: string): string[] {
  const match = new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(source);
  if (!match) throw new Error(`interface ${name} not found`);
  return [...match[1]!.matchAll(/^\s*(\w+)\??\s*:/gm)].map((entry) => entry[1]!);
}

/** Column aliases the catalog queries produce. */
function aliases(source: string): Set<string> {
  return new Set([...source.matchAll(/\bAS\s+(\w+)\s*,?\s*$/gim)].map((entry) => entry[1]!.toLowerCase()));
}

describe('catalog query aliases match the editor types', () => {
  const produced = aliases(routes);

  /**
   * Each entry is "the API produces this alias, and this interface must
   * declare it". Adding a catalog query means adding a line here.
   */
  const CONTRACT: { alias: string; iface: string }[] = [
    { alias: 'view_name', iface: 'ViewSummary' },
    // The one that broke: materialized views are aliased differently from
    // plain views, so they are a different type.
    { alias: 'matview_name', iface: 'MaterializedViewSummary' },
    { alias: 'function_name', iface: 'FunctionMetadata' },
    { alias: 'index_name', iface: 'IndexMetadata' },
    { alias: 'extension_name', iface: 'ExtensionMetadata' },
    { alias: 'enum_name', iface: 'EnumMetadata' },
  ];

  for (const { alias, iface } of CONTRACT) {
    it(`${iface} declares "${alias}", which the API actually sends`, () => {
      expect(produced.has(alias), `sql.routes.ts no longer aliases a column to "${alias}"`).toBe(true);
      expect(interfaceFields(types, iface)).toContain(alias);
    });
  }

  it('does not type materialized views as plain views', () => {
    // The specific regression: `materializedViews: ViewSummary[]` compiles and
    // is wrong at every field read.
    expect(types).toMatch(/materializedViews:\s*MaterializedViewSummary\[\]/);
    expect(types).not.toMatch(/materializedViews:\s*ViewSummary\[\]/);
  });
});

describe('the editor reads the fields the API sends', () => {
  it('never reads view_name off a materialized view', () => {
    for (const [name, source] of [
      ['page.tsx', editor],
      ['ide-schema-cache.ts', cache],
    ] as const) {
      // `mv.view_name` / `m.view_name` on a matview is the exact shape of the
      // bug; the identifiers used for materialized views are mv and m.
      expect(source, name).not.toMatch(/\bmv\.view_name\b/);
      expect(source, name).not.toMatch(/materializedViews[\s\S]{0,200}?\bm\.view_name\b/);
    }
  });

  it('reads matview_name where it renders materialized views', () => {
    expect(editor).toMatch(/\bmv\.matview_name\b/);
    expect(cache).toMatch(/\bm\.matview_name\b/);
  });

  it('does not lowercase a name before checking it exists', () => {
    // The autocomplete cache runs on every keystroke. One malformed row should
    // not be able to take the editor down.
    const guard = /\.filter\(\(name\): name is string =>/;
    expect(cache, 'ide-schema-cache.ts should filter names before lowercasing').toMatch(guard);
  });
});
