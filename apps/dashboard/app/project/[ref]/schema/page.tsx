'use client';

/**
 * Schema relationship diagram.
 *
 * Drawn as plain SVG rather than pulling in a graph library. The layout
 * problem here is small and specific — a handful of tables with foreign keys
 * between them — and a layered layout in eighty lines beats a dependency that
 * brings its own canvas, its own event model and its own opinions about
 * styling.
 *
 * Layout is by dependency depth: a table with no foreign keys sits in the
 * first column, a table referencing it in the second, and so on. That reads
 * far better than a force-directed blob, because schemas genuinely have a
 * direction — things point at their parents.
 */

import { use, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Panel, Skeleton, Empty } from '@/components/ui';

interface Relationship {
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
  constraint_name: string;
}
interface TableSummary { name: string; schema: string; columns?: number }

const CARD_WIDTH = 190;
const CARD_HEIGHT = 46;
const COLUMN_GAP = 120;
const ROW_GAP = 26;

export default function SchemaPage({ params }: { params: Promise<{ ref: string }> | { ref: string } }) {
  const { ref } = params instanceof Promise ? use(params) : params;
  const [selected, setSelected] = useState<string | null>(null);

  const tables = useQuery({
    queryKey: ['tables', ref],
    queryFn: () => api<TableSummary[]>(`/api/v1/projects/${ref}/database/tables`),
  });
  const relationships = useQuery({
    queryKey: ['relationships', ref],
    queryFn: () => api<Relationship[]>(`/api/v1/projects/${ref}/database/relationships`),
  });

  const layout = useMemo(() => {
    const names = (tables.data ?? []).map((table) => table.name);
    const edges = relationships.data ?? [];
    if (names.length === 0) return null;

    // Depth = longest chain of foreign keys out of this table. Computed with a
    // visited set because a schema with a cycle (self-reference, or a genuine
    // loop) must not send this into infinite recursion.
    const outgoing = new Map<string, string[]>();
    for (const edge of edges) {
      const list = outgoing.get(edge.source_table) ?? [];
      if (edge.target_table !== edge.source_table) list.push(edge.target_table);
      outgoing.set(edge.source_table, list);
    }

    const depthCache = new Map<string, number>();
    const depthOf = (name: string, seen: Set<string>): number => {
      if (depthCache.has(name)) return depthCache.get(name)!;
      if (seen.has(name)) return 0; // cycle: stop rather than recurse
      seen.add(name);
      const parents = outgoing.get(name) ?? [];
      const depth = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((parent) => depthOf(parent, seen)));
      seen.delete(name);
      depthCache.set(name, depth);
      return depth;
    };

    const columns = new Map<number, string[]>();
    for (const name of names) {
      const depth = depthOf(name, new Set());
      const list = columns.get(depth) ?? [];
      list.push(name);
      columns.set(depth, list);
    }

    const positions = new Map<string, { x: number; y: number }>();
    let maxRows = 0;
    for (const [depth, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
      list.sort();
      maxRows = Math.max(maxRows, list.length);
      list.forEach((name, index) => {
        positions.set(name, {
          x: 20 + depth * (CARD_WIDTH + COLUMN_GAP),
          y: 20 + index * (CARD_HEIGHT + ROW_GAP),
        });
      });
    }

    const width = 40 + columns.size * CARD_WIDTH + Math.max(0, columns.size - 1) * COLUMN_GAP;
    const height = 40 + maxRows * (CARD_HEIGHT + ROW_GAP);
    return { positions, edges, width, height };
  }, [tables.data, relationships.data]);

  if (tables.isLoading || relationships.isLoading) {
    return <main className="px-8 py-10"><h1 className="text-xl font-semibold text-body">Schema</h1><div className="mt-6"><Skeleton rows={5} /></div></main>;
  }

  if (!layout) {
    return (
      <main className="px-8 py-10">
        <h1 className="text-xl font-semibold text-body">Schema</h1>
        <div className="mt-6">
          <Empty title="No tables yet" description="Create a table in the editor and it will appear here." />
        </div>
      </main>
    );
  }

  const related = new Set<string>();
  if (selected) {
    for (const edge of layout.edges) {
      if (edge.source_table === selected) related.add(edge.target_table);
      if (edge.target_table === selected) related.add(edge.source_table);
    }
  }

  return (
    <main className="px-8 py-10">
      <h1 className="text-xl font-semibold text-body">Schema</h1>
      <p className="mt-1 text-sm text-muted">
        Laid out by foreign-key depth — tables that depend on nothing are on the left. Click one to trace its links.
      </p>

      <div className="mt-6">
        <Panel title={`${layout.positions.size} tables, ${layout.edges.length} relationships`}>
          <div className="overflow-x-auto">
            <svg
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              width={layout.width}
              height={layout.height}
              role="img"
              aria-label="Schema relationship diagram"
              className="max-w-full"
            >
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-muted" />
                </marker>
              </defs>

              {layout.edges.map((edge, index) => {
                const from = layout.positions.get(edge.source_table);
                const to = layout.positions.get(edge.target_table);
                if (!from || !to) return null;

                const x1 = from.x + CARD_WIDTH;
                const y1 = from.y + CARD_HEIGHT / 2;
                const x2 = to.x;
                const y2 = to.y + CARD_HEIGHT / 2;
                const midX = (x1 + x2) / 2;

                const highlighted = selected === edge.source_table || selected === edge.target_table;
                const dimmed = selected !== null && !highlighted;

                return (
                  <g key={`${edge.constraint_name}-${index}`} opacity={dimmed ? 0.15 : 1}>
                    <path
                      d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke={highlighted ? 'var(--signal, #7C6BF2)' : 'currentColor'}
                      strokeWidth={highlighted ? 2 : 1}
                      className={highlighted ? '' : 'text-edge'}
                      markerEnd="url(#arrow)"
                    />
                    {highlighted ? (
                      <text x={midX} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="fill-muted" fontSize="10" fontFamily="monospace">
                        {edge.source_column} → {edge.target_column}
                      </text>
                    ) : null}
                  </g>
                );
              })}

              {[...layout.positions.entries()].map(([name, position]) => {
                const isSelected = selected === name;
                const isRelated = related.has(name);
                const dimmed = selected !== null && !isSelected && !isRelated;
                return (
                  <g
                    key={name}
                    transform={`translate(${position.x}, ${position.y})`}
                    opacity={dimmed ? 0.3 : 1}
                    onClick={() => setSelected(isSelected ? null : name)}
                    style={{ cursor: 'pointer' }}
                  >
                    <rect
                      width={CARD_WIDTH}
                      height={CARD_HEIGHT}
                      rx={6}
                      className={isSelected ? 'fill-raised' : 'fill-panel'}
                      stroke={isSelected ? 'var(--signal, #7C6BF2)' : 'currentColor'}
                      strokeWidth={isSelected ? 2 : 1}
                      style={{ color: isSelected ? undefined : '#2A303C' }}
                    />
                    <text x={12} y={28} className="fill-body" fontSize="13" fontFamily="monospace">
                      {name.length > 20 ? `${name.slice(0, 19)}…` : name}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </Panel>
      </div>

      {selected ? (
        <div className="mt-6">
          <Panel title={`${selected} — relationships`}>
            <ul className="space-y-1.5 font-mono text-xs">
              {layout.edges
                .filter((edge) => edge.source_table === selected || edge.target_table === selected)
                .map((edge, index) => (
                  <li key={index} className="text-muted">
                    <span className="text-body">{edge.source_table}.{edge.source_column}</span>
                    {' → '}
                    <span className="text-body">{edge.target_table}.{edge.target_column}</span>
                  </li>
                ))}
            </ul>
          </Panel>
        </div>
      ) : null}
    </main>
  );
}
