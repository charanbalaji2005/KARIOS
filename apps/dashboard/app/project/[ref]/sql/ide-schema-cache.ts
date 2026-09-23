import type { SchemaCatalog } from './ide-types';

export interface SqlDiagnostic {
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

/**
 * Parses table aliases from a SQL string (e.g. "FROM users u" or "JOIN profiles p ON")
 */
export function extractTableAliases(sql: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  const fromJoinRegex = /\b(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?\b/gi;
  let match: RegExpExecArray | null;

  while ((match = fromJoinRegex.exec(sql)) !== null) {
    const tableName = match[1];
    const alias = match[2];
    if (alias && alias.toUpperCase() !== 'ON' && alias.toUpperCase() !== 'WHERE' && alias.toUpperCase() !== 'JOIN') {
      aliases[alias.toLowerCase()] = tableName.toLowerCase();
    }
    if (tableName) {
      aliases[tableName.toLowerCase()] = tableName.toLowerCase();
    }
  }

  return aliases;
}

/**
 * Registers an intelligent, schema-aware autocomplete provider in Monaco for PostgreSQL.
 */
export function registerSchemaAutocomplete(schema: SchemaCatalog | null, monaco: any) {
  return monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' ', '('],
    provideCompletionItems: (model: any, position: any) => {
      const lineContent = model.getLineContent(position.lineNumber);
      const textUntilPosition = lineContent.substring(0, position.column - 1);
      const fullSql = model.getValue();
      const aliases = extractTableAliases(fullSql);

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: any[] = [];

      // Check if typing after a dot (e.g. "u." or "users.")
      const dotMatch = textUntilPosition.match(/([a-zA-Z0-9_]+)\.$/);
      if (dotMatch) {
        const prefix = dotMatch[1].toLowerCase();
        const targetTable = aliases[prefix] || prefix;

        // Suggest columns for the target table
        if (schema?.columns) {
          const targetCols = schema.columns.filter(
            (c) => c.table_name.toLowerCase() === targetTable,
          );
          targetCols.forEach((col) => {
            suggestions.push({
              label: col.column_name,
              kind: col.is_primary_key
                ? monaco.languages.CompletionItemKind.Field
                : monaco.languages.CompletionItemKind.Property,
              insertText: col.column_name,
              detail: `${col.data_type}${col.is_primary_key ? ' (PK)' : ''}`,
              documentation: `Column of ${col.table_name}. Nullable: ${col.is_nullable ? 'YES' : 'NO'}${
                col.column_default ? ` | Default: ${col.column_default}` : ''
              }`,
              range,
            });
          });
        }
        return { suggestions };
      }

      // If schema is available, suggest table names
      if (schema?.tables) {
        schema.tables.forEach((t) => {
          suggestions.push({
            label: t.table_name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: t.table_name,
            detail: `Table (${t.schema_name})`,
            documentation: `Estimated rows: ${t.estimated_rows}${t.rls_enabled ? ' · RLS Enabled' : ''}`,
            range,
          });
        });
      }

      // Suggest views
      if (schema?.views) {
        schema.views.forEach((v) => {
          suggestions.push({
            label: v.view_name,
            kind: monaco.languages.CompletionItemKind.Interface,
            insertText: v.view_name,
            detail: `View (${v.schema_name})`,
            documentation: v.definition ? `Definition:\n${v.definition}` : undefined,
            range,
          });
        });
      }

      // Suggest column names across all tables
      if (schema?.columns) {
        const seenCols = new Set<string>();
        schema.columns.forEach((col) => {
          if (!seenCols.has(col.column_name)) {
            seenCols.add(col.column_name);
            suggestions.push({
              label: col.column_name,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: col.column_name,
              detail: `Column (${col.data_type}) in ${col.table_name}`,
              range,
            });
          }
        });
      }

      // Suggest user-defined functions
      if (schema?.functions) {
        schema.functions.forEach((fn) => {
          suggestions.push({
            label: `${fn.function_name}()`,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: `${fn.function_name}(${fn.arguments || ''})`,
            detail: `Function (${fn.arguments}) -> ${fn.return_type}`,
            range,
          });
        });
      }

      // Suggest custom functions and PostgreSQL built-ins
      const builtins = [
        { label: 'COUNT(*)', text: 'COUNT(*)', detail: 'Aggregate row count' },
        { label: 'COALESCE()', text: 'COALESCE(${1:val1}, ${2:val2})', detail: 'Return first non-null' },
        { label: 'NOW()', text: 'NOW()', detail: 'Current timestamp' },
        { label: 'GEN_RANDOM_UUID()', text: 'gen_random_uuid()', detail: 'Generate v4 UUID' },
        { label: 'DATE_TRUNC()', text: "date_trunc('${1:day}', ${2:timestamp})", detail: 'Truncate timestamp' },
        { label: 'ROW_NUMBER() OVER()', text: 'ROW_NUMBER() OVER (${1:ORDER BY created_at DESC})', detail: 'Window function' },
        { label: 'JSONB_BUILD_OBJECT()', text: "jsonb_build_object('${1:key}', ${2:value})", detail: 'Build JSONB object' },
      ];

      builtins.forEach((fn) => {
        suggestions.push({
          label: fn.label,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: fn.text,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: fn.detail,
          range,
        });
      });

      // Suggest SQL clauses and snippets
      const snippets = [
        { label: 'SELECT * FROM', text: 'SELECT * FROM ${1:table} LIMIT 20;' },
        { label: 'SELECT COUNT', text: 'SELECT count(*) FROM ${1:table};' },
        { label: 'INSERT INTO', text: 'INSERT INTO ${1:table} (${2:col1}) VALUES (${3:val1}) RETURNING *;' },
        { label: 'UPDATE SET', text: 'UPDATE ${1:table} SET ${2:col} = ${3:val} WHERE ${4:condition};' },
        { label: 'DELETE FROM', text: 'DELETE FROM ${1:table} WHERE ${2:condition};' },
        { label: 'JOIN', text: 'LEFT JOIN ${1:table} ON ${1:table}.${2:id} = ${3:parent}.${4:foreign_id}' },
        { label: 'WITH (CTE)', text: 'WITH ${1:cte_name} AS (\n  SELECT * FROM ${2:table}\n)\nSELECT * FROM ${1:cte_name};' },
        { label: 'TRANSACTION BEGIN...COMMIT', text: 'BEGIN;\n  ${1:-- SQL statements}\nCOMMIT;' },
      ];

      snippets.forEach((s) => {
        suggestions.push({
          label: s.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: s.text,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      });

      return { suggestions };
    },
  });
}

/**
 * Performs client-side diagnostics and schema-aware linting on the current SQL string.
 */
export function lintSqlQuery(sql: string, schema: SchemaCatalog | null): SqlDiagnostic[] {
  const diagnostics: SqlDiagnostic[] = [];
  const lines = sql.split('\n');

  // Check 1: Destructive operations without WHERE
  const s = sql.toLowerCase().trim();
  if (/^\s*delete\s+from\s+[a-zA-Z0-9_]+\s*;?\s*$/i.test(s) || (/delete\s+from\b/i.test(s) && !/\bwhere\b/i.test(s))) {
    diagnostics.push({
      line: 1,
      column: 1,
      message: 'Unbounded DELETE statement without a WHERE clause will delete ALL rows.',
      severity: 'warning',
    });
  }

  if (/^\s*update\s+[a-zA-Z0-9_]+\s+set\b/i.test(s) && !/\bwhere\b/i.test(s)) {
    diagnostics.push({
      line: 1,
      column: 1,
      message: 'Unbounded UPDATE statement without a WHERE clause will modify ALL rows in the table.',
      severity: 'warning',
    });
  }

  if (/^\s*drop\s+table\b/i.test(s)) {
    diagnostics.push({
      line: 1,
      column: 1,
      message: 'DROP TABLE statement detected. This will permanently destroy data.',
      severity: 'warning',
    });
  }

  // Check 2: Unmatched parentheses
  let openParens = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '(') openParens++;
      if (line[c] === ')') openParens--;
    }
  }
  if (openParens !== 0) {
    diagnostics.push({
      line: lines.length,
      column: lines[lines.length - 1].length + 1,
      message: openParens > 0 ? `Missing ${openParens} closing parenthesis ')'` : `Unmatched ${-openParens} closing parenthesis ')'`,
      severity: 'error',
    });
  }

  // Check 3: Schema-aware check for unknown relations (tables + views)
  if (schema?.tables || schema?.views) {
    // Filter before lowercasing. This runs on every keystroke, so a single row
    // missing its name should not take the editor down with it — which is
    // exactly what happened when materialized views were read as `view_name`.
    const tableSet = new Set(
      [
        ...(schema.tables || []).map((t) => t.table_name),
        ...(schema.views || []).map((v) => v.view_name),
        ...(schema.materializedViews || []).map((m) => m.matview_name),
      ]
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .map((name) => name.toLowerCase()),
    );
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = /\b(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)\b/gi;
      let fromMatch: RegExpExecArray | null;
      while ((fromMatch = match.exec(line)) !== null) {
        const tbl = fromMatch[1].toLowerCase();
        // Skip common keywords or subqueries
        if (['select', 'lateral', 'values', 'jsonb_array_elements', 'generate_series'].includes(tbl)) continue;
        if (!tableSet.has(tbl)) {
          diagnostics.push({
            line: i + 1,
            column: fromMatch.index + fromMatch[0].length - tbl.length + 1,
            message: `Relation "${tbl}" does not exist in schema "${schema.schema || 'public'}".`,
            severity: 'warning',
          });
        }
      }
    }
  }

  return diagnostics;
}
