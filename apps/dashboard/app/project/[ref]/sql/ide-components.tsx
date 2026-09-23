'use client';

import React, { useState, useMemo } from 'react';
import {
  AlertTriangle,
  BarChart2,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Code,
  Copy,
  Database,
  Download,
  Edit2,
  ExternalLink,
  Eye,
  FileSpreadsheet,
  Filter,
  HardDrive,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Server,
  Table as TableIcon,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { formatBytes } from '@/lib/api';
import type {
  ActiveConnection,
  BlockedLock,
  ColumnMetadata,
  DiagnosticsData,
  ExecuteResult,
  ExplainFinding,
  ExplainResult,
  SchemaCatalog,
  TableStat,
  TableSummary,
} from './ide-types';

/* ─────────────────────────────────────────────────────────────
   1. RESULT GRID COMPONENT (Sort, Filter, Inline Edit, Insert, Delete, Chart)
───────────────────────────────────────────────────────────── */
interface ResultGridProps {
  result: ExecuteResult;
  targetTable?: string;
  schemaCatalog?: SchemaCatalog | null;
  onExecuteSql: (sql: string, parameters?: unknown[]) => void;
}

export function ResultGrid({ result, targetTable, schemaCatalog, onExecuteSql }: ResultGridProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [pageSize, setPageSize] = useState(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'table' | 'json' | 'chart'>('table');
  const [selectedCell, setSelectedCell] = useState<{ rowIdx: number; colName: string } | null>(null);
  const [editingCell, setEditingCell] = useState<{ row: Record<string, unknown>; colName: string; currentVal: string } | null>(null);
  const [newVal, setNewVal] = useState('');
  const [deleteConfirmRow, setDeleteConfirmRow] = useState<Record<string, unknown> | null>(null);
  const [showInsertModal, setShowInsertModal] = useState(false);
  const [copiedCell, setCopiedCell] = useState<string | null>(null);

  // Determine primary key column for the target table
  const pkCol = useMemo(() => {
    if (!targetTable || !schemaCatalog?.columns) return 'id';
    const match = schemaCatalog.columns.find(
      (c) => c.table_name.toLowerCase() === targetTable.toLowerCase() && c.is_primary_key,
    );
    return match ? match.column_name : 'id';
  }, [targetTable, schemaCatalog]);

  const columns = useMemo(() => {
    if (result.columns && result.columns.length > 0) {
      return result.columns.map((c) => c.name);
    }
    if (result.data && result.data.length > 0) {
      return Object.keys(result.data[0]);
    }
    return [];
  }, [result]);

  // Filter & Sort
  const processedData = useMemo(() => {
    let data = result.data || [];
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      data = data.filter((row) =>
        Object.values(row).some((val) => String(val ?? '').toLowerCase().includes(term)),
      );
    }
    if (sortCol) {
      data = [...data].sort((a, b) => {
        const valA = a[sortCol];
        const valB = b[sortCol];
        if (valA === valB) return 0;
        if (valA === null || valA === undefined) return 1;
        if (valB === null || valB === undefined) return -1;
        if (typeof valA === 'number' && typeof valB === 'number') {
          return sortAsc ? valA - valB : valB - valA;
        }
        return sortAsc
          ? String(valA).localeCompare(String(valB))
          : String(valB).localeCompare(String(valA));
      });
    }
    return data;
  }, [result.data, searchTerm, sortCol, sortAsc]);

  const totalPages = Math.ceil(processedData.length / pageSize) || 1;
  const paginatedData = useMemo(() => {
    const start = pageIndex * pageSize;
    return processedData.slice(start, start + pageSize);
  }, [processedData, pageIndex, pageSize]);

  // Numeric columns for charting
  const numericColumns = useMemo(() => {
    if (!result.data || result.data.length === 0) return [];
    const first = result.data[0];
    return columns.filter((col) => typeof first[col] === 'number');
  }, [result.data, columns]);

  const [chartCol, setChartCol] = useState<string>(numericColumns[0] || columns[0] || '');

  const handleCopyCell = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCell(id);
    setTimeout(() => setCopiedCell(null), 1500);
  };

  const handleDownloadCsv = () => {
    if (!result.data || result.data.length === 0) return;
    const headers = columns.join(',');
    const rows = result.data.map((row) =>
      columns
        .map((col) => {
          const val = row[col];
          if (val === null || val === undefined) return '""';
          const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
          return `"${str.replace(/"/g, '""')}"`;
        })
        .join(','),
    );
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers, ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `kairos_query_export_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDownloadJson = () => {
    if (!result.data || result.data.length === 0) return;
    const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kairos_query_export_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const executeCellUpdate = () => {
    if (!editingCell || !targetTable) return;
    const idVal = editingCell.row[pkCol];
    if (idVal === undefined) {
      alert(`Cannot update row: Primary key column "${pkCol}" not found in result row.`);
      return;
    }
    const updateSql = `UPDATE ${targetTable} SET ${editingCell.colName} = $1 WHERE ${pkCol} = $2;`;
    onExecuteSql(updateSql, [newVal, idVal]);
    setEditingCell(null);
  };

  const executeRowDelete = () => {
    if (!deleteConfirmRow || !targetTable) return;
    const idVal = deleteConfirmRow[pkCol];
    if (idVal === undefined) {
      alert(`Cannot delete row: Primary key column "${pkCol}" not found in result row.`);
      return;
    }
    const deleteSql = `DELETE FROM ${targetTable} WHERE ${pkCol} = $1;`;
    onExecuteSql(deleteSql, [idVal]);
    setDeleteConfirmRow(null);
  };

  return (
    <div className="flex flex-col h-full bg-sheet text-body font-mono text-xs">
      {/* Top action & filter bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-3 py-2 bg-panel">
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-lg border border-edge bg-sheet p-0.5">
            <button
              onClick={() => setViewMode('table')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-sans font-medium transition-colors ${
                viewMode === 'table' ? 'bg-raised text-signal shadow-sm' : 'text-muted hover:text-body'
              }`}
            >
              <TableIcon className="h-3.5 w-3.5" /> Table
            </button>
            <button
              onClick={() => setViewMode('json')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-sans font-medium transition-colors ${
                viewMode === 'json' ? 'bg-raised text-signal shadow-sm' : 'text-muted hover:text-body'
              }`}
            >
              <Code className="h-3.5 w-3.5" /> JSON
            </button>
            <button
              onClick={() => setViewMode('chart')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-sans font-medium transition-colors ${
                viewMode === 'chart' ? 'bg-raised text-signal shadow-sm' : 'text-muted hover:text-body'
              }`}
            >
              <BarChart2 className="h-3.5 w-3.5" /> Chart
            </button>
          </div>

          {/* Search filter input */}
          <div className="relative">
            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted" />
            <input
              type="text"
              placeholder="Filter result rows..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setPageIndex(0);
              }}
              className="h-7 w-48 rounded-md border border-edge bg-raised/50 pl-7 pr-2 text-[11px] text-body placeholder:text-muted focus:border-signal focus:outline-none"
            />
          </div>

          <span className="text-[11px] text-muted font-sans">
            {processedData.length} row{processedData.length === 1 ? '' : 's'}
            {result.meta?.executionTimeMs ? ` (${result.meta.executionTimeMs} ms)` : ''}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {targetTable ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowInsertModal(true)}
              className="h-7 gap-1 text-[11px] border border-edge text-mint hover:bg-mint/10"
            >
              <Plus className="h-3 w-3" /> Insert Row
            </Button>
          ) : null}

          <Button
            size="sm"
            variant="ghost"
            onClick={handleDownloadCsv}
            className="h-7 gap-1 text-[11px] border border-edge hover:bg-raised text-muted hover:text-body"
            title="Download CSV"
          >
            <Download className="h-3 w-3" /> CSV
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDownloadJson}
            className="h-7 gap-1 text-[11px] border border-edge hover:bg-raised text-muted hover:text-body"
            title="Download JSON"
          >
            <Download className="h-3 w-3" /> JSON
          </Button>

          {/* Page size selector */}
          <div className="flex items-center gap-1 text-[11px] text-muted">
            <span>Show:</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPageIndex(0);
              }}
              className="rounded border border-edge bg-raised px-1 py-0.5 text-[11px] text-body focus:outline-none"
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
              <option value={500}>500</option>
            </select>
          </div>
        </div>
      </div>

      {/* Main Grid View Content */}
      <div className="flex-1 overflow-auto">
        {viewMode === 'table' ? (
          columns.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-muted">No columns or rows returned.</div>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-raised border-b border-edge select-none">
                <tr>
                  <th className="w-10 border-r border-edge/60 px-2 py-1.5 text-center text-[10px] text-muted font-normal">
                    #
                  </th>
                  {columns.map((col) => {
                    const isSorted = sortCol === col;
                    return (
                      <th
                        key={col}
                        onClick={() => {
                          if (sortCol === col) {
                            setSortAsc(!sortAsc);
                          } else {
                            setSortCol(col);
                            setSortAsc(true);
                          }
                        }}
                        className="cursor-pointer border-r border-edge/60 px-3 py-1.5 text-[11px] font-semibold text-body hover:bg-edge/40 transition-colors whitespace-nowrap"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span>{col}</span>
                          <span className="text-[10px] text-signal font-mono">
                            {isSorted ? (sortAsc ? '▲' : '▼') : ''}
                          </span>
                        </div>
                      </th>
                    );
                  })}
                  {targetTable ? (
                    <th className="w-12 px-2 py-1.5 text-center text-[10px] text-muted font-normal">Actions</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {paginatedData.map((row, rIdx) => {
                  const globalIdx = pageIndex * pageSize + rIdx + 1;
                  return (
                    <tr
                      key={rIdx}
                      className="border-b border-edge/40 hover:bg-raised/40 transition-colors group"
                    >
                      <td className="border-r border-edge/40 px-2 py-1 text-center text-[10px] text-muted/80 bg-raised/20">
                        {globalIdx}
                      </td>
                      {columns.map((col) => {
                        const val = row[col];
                        const cellId = `${rIdx}-${col}`;
                        const isNull = val === null || val === undefined;
                        const isSelected = selectedCell?.rowIdx === rIdx && selectedCell?.colName === col;
                        let displayVal = isNull ? 'NULL' : typeof val === 'object' ? JSON.stringify(val) : String(val);

                        return (
                          <td
                            key={col}
                            onClick={() => setSelectedCell({ rowIdx: rIdx, colName: col })}
                            onDoubleClick={() => {
                              if (targetTable) {
                                setEditingCell({
                                  row,
                                  colName: col,
                                  currentVal: isNull ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val),
                                });
                                setNewVal(isNull ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val));
                              }
                            }}
                            className={`border-r border-edge/40 px-3 py-1 text-[11px] max-w-xs truncate cursor-cell relative ${
                              isSelected ? 'bg-signal/10 ring-1 ring-inset ring-signal' : ''
                            } ${isNull ? 'italic text-muted/60' : 'text-body'}`}
                            title={targetTable ? `${displayVal}\n(Double-click to inline edit)` : displayVal}
                          >
                            <div className="flex items-center justify-between gap-1 overflow-hidden">
                              <span className="truncate">{displayVal}</span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopyCell(displayVal, cellId);
                                }}
                                className="opacity-0 group-hover:opacity-100 hover:text-signal p-0.5 transition-opacity"
                                title="Copy cell value"
                              >
                                {copiedCell === cellId ? <Check className="h-3 w-3 text-mint" /> : <Copy className="h-3 w-3" />}
                              </button>
                            </div>
                          </td>
                        );
                      })}
                      {targetTable ? (
                        <td className="px-2 py-1 text-center">
                          <button
                            onClick={() => setDeleteConfirmRow(row)}
                            className="opacity-0 group-hover:opacity-100 text-muted hover:text-coral transition-opacity p-0.5"
                            title="Delete this row"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : viewMode === 'json' ? (
          <div className="p-3">
            <pre className="rounded-lg border border-edge bg-raised/30 p-3 text-[11px] text-body overflow-auto max-h-[450px]">
              {JSON.stringify(processedData, null, 2)}
            </pre>
          </div>
        ) : (
          /* CHART VIEW */
          <div className="p-4 space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted">Chart Column:</span>
              <select
                value={chartCol}
                onChange={(e) => setChartCol(e.target.value)}
                className="rounded border border-edge bg-raised px-2 py-1 text-xs text-body"
              >
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="rounded-xl border border-edge bg-raised/20 p-4 space-y-2">
              <span className="text-[11px] text-muted block mb-3">
                Value Distribution for <strong className="text-signal">{chartCol}</strong> (first {Math.min(processedData.length, 30)} rows):
              </span>
              <div className="flex items-end gap-1.5 h-48 pt-6 border-b border-edge">
                {processedData.slice(0, 30).map((row, idx) => {
                  const rawVal = Number(row[chartCol]);
                  const val = isNaN(rawVal) ? 0 : rawVal;
                  const max = Math.max(...processedData.slice(0, 30).map((r) => Number(r[chartCol]) || 1), 1);
                  const heightPercent = Math.min(Math.max((val / max) * 100, 4), 100);

                  return (
                    <div
                      key={idx}
                      className="flex-1 flex flex-col items-center gap-1 group relative h-full justify-end"
                    >
                      {/* Tooltip on hover */}
                      <div className="absolute -top-7 opacity-0 group-hover:opacity-100 transition-opacity bg-panel border border-edge text-[10px] px-1.5 py-0.5 rounded shadow pointer-events-none whitespace-nowrap z-20">
                        Row #{idx + 1}: {val}
                      </div>
                      <div
                        style={{ height: `${heightPercent}%` }}
                        className="w-full bg-signal/70 hover:bg-signal rounded-t transition-all"
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between text-[10px] text-muted pt-1">
                <span>Row #1</span>
                <span>Row #{Math.min(processedData.length, 30)}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Pagination Footer */}
      {viewMode === 'table' && totalPages > 1 ? (
        <div className="flex items-center justify-between border-t border-edge bg-panel px-3 py-1.5 text-[11px] text-muted">
          <span>
            Page {pageIndex + 1} of {totalPages} ({processedData.length} total rows)
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPageIndex(Math.max(0, pageIndex - 1))}
              disabled={pageIndex === 0}
              className="rounded px-2 py-0.5 border border-edge bg-raised hover:bg-edge disabled:opacity-40 transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => setPageIndex(Math.min(totalPages - 1, pageIndex + 1))}
              disabled={pageIndex >= totalPages - 1}
              className="rounded px-2 py-0.5 border border-edge bg-raised hover:bg-edge disabled:opacity-40 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      {/* ─────────────────────────────────────────────────────────────
          INLINE EDIT CONFIRMATION MODAL (Generates safe UPDATE SQL)
      ───────────────────────────────────────────────────────────── */}
      {editingCell && targetTable ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-edge bg-panel p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-edge pb-2">
              <div className="flex items-center gap-2">
                <Edit2 className="h-4 w-4 text-signal" />
                <h3 className="font-semibold text-body text-sm">Edit Table Row Value</h3>
              </div>
              <button onClick={() => setEditingCell(null)} className="text-muted hover:text-body">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="rounded-lg bg-raised/40 p-2.5 border border-edge space-y-1">
                <div className="flex justify-between text-muted">
                  <span>Target Table:</span>
                  <span className="font-semibold text-body font-mono">{targetTable}</span>
                </div>
                <div className="flex justify-between text-muted">
                  <span>Column:</span>
                  <span className="font-semibold text-signal font-mono">{editingCell.colName}</span>
                </div>
                <div className="flex justify-between text-muted">
                  <span>Row Key ({pkCol}):</span>
                  <span className="font-mono text-body">{String(editingCell.row[pkCol])}</span>
                </div>
              </div>

              <div>
                <label className="text-[11px] text-muted block mb-1">New Value:</label>
                <Input
                  value={newVal}
                  onChange={(e) => setNewVal(e.target.value)}
                  placeholder="Enter new column value"
                  className="font-mono text-xs"
                  autoFocus
                />
              </div>

              <div>
                <span className="text-[10px] text-muted uppercase font-semibold tracking-wider">
                  Generated Parameterized SQL:
                </span>
                <pre className="mt-1 rounded bg-raised p-2 text-[11px] font-mono text-signal overflow-x-auto border border-edge">
                  {`UPDATE ${targetTable}\nSET ${editingCell.colName} = $1\nWHERE ${pkCol} = $2;`}
                </pre>
                <span className="text-[10px] text-muted block mt-1">
                  Parameters: [ $1: &quot;{newVal}&quot;, $2: &quot;{String(editingCell.row[pkCol])}&quot; ]
                </span>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-edge">
              <Button size="sm" variant="ghost" onClick={() => setEditingCell(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={executeCellUpdate}>
                Apply Update
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ─────────────────────────────────────────────────────────────
          DELETE ROW CONFIRMATION MODAL (Generates safe DELETE SQL)
      ───────────────────────────────────────────────────────────── */}
      {deleteConfirmRow && targetTable ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-coral/50 bg-panel p-5 shadow-2xl space-y-4">
            <div className="flex items-center gap-2 text-coral">
              <AlertTriangle className="h-5 w-5" />
              <h3 className="font-semibold text-body text-sm">Delete Row Confirmation</h3>
            </div>

            <p className="text-xs text-muted">
              Are you sure you want to permanently delete this row from <strong className="text-body">{targetTable}</strong>?
            </p>

            <div className="rounded-lg bg-coral/10 border border-coral/30 p-2.5 text-xs font-mono space-y-1">
              <div className="flex justify-between">
                <span className="text-muted">Target Column ({pkCol}):</span>
                <span className="text-coral font-bold">{String(deleteConfirmRow[pkCol])}</span>
              </div>
            </div>

            <div>
              <span className="text-[10px] text-muted uppercase font-semibold tracking-wider">
                Generated Safe SQL:
              </span>
              <pre className="mt-1 rounded bg-raised p-2 text-[11px] font-mono text-coral overflow-x-auto border border-edge">
                {`DELETE FROM ${targetTable} WHERE ${pkCol} = $1;`}
              </pre>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-edge">
              <Button size="sm" variant="ghost" onClick={() => setDeleteConfirmRow(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-coral hover:bg-coral/90 text-white font-semibold"
                onClick={executeRowDelete}
              >
                Delete Row
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ─────────────────────────────────────────────────────────────
          INSERT ROW MODAL (Generates INSERT SQL)
      ───────────────────────────────────────────────────────────── */}
      {showInsertModal && targetTable ? (
        <InsertRowModal
          tableName={targetTable}
          columns={columns.filter((c) => c !== 'id' && c !== 'created_at')}
          columnMetas={schemaCatalog?.columns?.filter((c) => c.table_name === targetTable)}
          onClose={() => setShowInsertModal(false)}
          onInsert={(sql, params) => {
            onExecuteSql(sql, params);
            setShowInsertModal(false);
          }}
        />
      ) : null}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   2. INSERT ROW MODAL SUBCOMPONENT
───────────────────────────────────────────────────────────── */
interface InsertRowModalProps {
  tableName: string;
  columns: string[];
  columnMetas?: ColumnMetadata[];
  onClose: () => void;
  onInsert: (sql: string, params: unknown[]) => void;
}

function InsertRowModal({ tableName, columns, columnMetas, onClose, onInsert }: InsertRowModalProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [validationWarning, setValidationWarning] = useState<string | null>(null);

  const isColRequired = (colName: string) => {
    const meta = columnMetas?.find((c) => c.column_name === colName);
    if (!meta) return false;
    return !meta.is_nullable && !meta.column_default;
  };

  const generatedSql = useMemo(() => {
    const activeCols = columns.filter((col) => values[col] !== undefined && values[col].trim() !== '');
    if (activeCols.length === 0) return `INSERT INTO ${tableName} DEFAULT VALUES RETURNING *;`;
    const colsList = activeCols.join(', ');
    const paramsList = activeCols.map((_, i) => `$${i + 1}`).join(', ');
    return `INSERT INTO ${tableName} (${colsList})\nVALUES (${paramsList})\nRETURNING *;`;
  }, [tableName, columns, values]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationWarning(null);

    // Validate required (NOT NULL with no default) columns
    const missing = columns.filter((col) => isColRequired(col) && (!values[col] || values[col].trim() === ''));
    if (missing.length > 0) {
      setValidationWarning(`Column(s) required: ${missing.map((m) => `"${m}"`).join(', ')} cannot be null.`);
      return;
    }

    const activeCols = columns.filter((col) => values[col] !== undefined && values[col].trim() !== '');
    const params = activeCols.map((col) => values[col].trim());
    onInsert(generatedSql, params);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-full max-w-lg rounded-2xl border border-edge bg-panel p-5 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-edge pb-2">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-mint" />
            <h3 className="font-semibold text-body text-sm">Insert New Row into {tableName}</h3>
          </div>
          <button onClick={onClose} className="text-muted hover:text-body">
            <X className="h-4 w-4" />
          </button>
        </div>

        {validationWarning ? (
          <div className="rounded-lg bg-coral/10 border border-coral/30 p-2.5 text-xs text-coral flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{validationWarning}</span>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto space-y-3 pr-1">
          <div className="space-y-2">
            {columns.map((col) => {
              const req = isColRequired(col);
              const meta = columnMetas?.find((c) => c.column_name === col);

              return (
                <div key={col} className="flex items-center gap-3">
                  <label className="w-1/3 text-[11px] font-mono text-muted truncate text-right">
                    {req ? <span className="text-coral font-bold mr-1">*</span> : null}
                    {meta?.foreign_table ? (
                      <span className="rounded bg-signal/15 px-1 py-0.2 text-[9px] font-mono text-signal mr-1 border border-signal/30">
                        FK
                      </span>
                    ) : null}
                    {col}:
                  </label>
                  <div className="w-2/3 space-y-0.5">
                    <Input
                      value={values[col] || ''}
                      onChange={(e) => {
                        setValues({ ...values, [col]: e.target.value });
                        if (validationWarning) setValidationWarning(null);
                      }}
                      placeholder={
                        meta?.foreign_table
                          ? `FK -> ${meta.foreign_table}.${meta.foreign_column || 'id'}${meta.is_nullable ? ' (leave empty for NULL)' : ' (Required)'}`
                          : req
                          ? `Required (${meta?.data_type || 'value'})`
                          : `Optional (${meta?.data_type || 'value'})`
                      }
                      className={`h-8 font-mono text-xs ${req && !values[col] ? 'border-coral/50' : ''}`}
                    />
                    {meta?.foreign_table ? (
                      <span className="text-[9px] text-signal/80 block truncate">
                        References {meta.foreign_table}({meta.foreign_column || 'id'})
                        {meta.is_nullable ? ' • Leave empty for NULL' : ''}
                      </span>
                    ) : meta?.column_default ? (
                      <span className="text-[9px] text-muted/60 block truncate">
                        Default: {meta.column_default}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-2">
            <span className="text-[10px] text-muted uppercase font-semibold tracking-wider">
              Generated SQL Preview:
            </span>
            <pre className="mt-1 rounded bg-raised p-2 text-[11px] font-mono text-signal overflow-x-auto border border-edge">
              {generatedSql}
            </pre>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-edge">
            <Button size="sm" variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" className="bg-mint hover:bg-mint/90 text-sheet">
              Insert Row
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   3. VISUAL QUERY PLAN COMPONENT (EXPLAIN & EXPLAIN ANALYZE)
───────────────────────────────────────────────────────────── */
interface VisualQueryPlanProps {
  planResult: ExplainResult;
}

export function VisualQueryPlan({ planResult }: VisualQueryPlanProps) {
  const planNode = planResult.plan?.Plan as Record<string, unknown> | undefined;

  return (
    <div className="h-full overflow-auto bg-sheet p-4 space-y-4 font-mono text-xs">
      {/* Plan Header & Timing Badges */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel p-3">
        <div className="flex items-center gap-3">
          <span className="rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider bg-signal/15 text-signal border border-signal/30">
            {planResult.analyzed ? 'EXPLAIN ANALYZE' : 'EXPLAIN PLAN'}
          </span>
          {planResult.planningTimeMs !== null ? (
            <span className="text-muted text-[11px]">
              Planning: <strong className="text-body">{planResult.planningTimeMs.toFixed(2)} ms</strong>
            </span>
          ) : null}
          {planResult.executionTimeMs !== null ? (
            <span className="text-muted text-[11px]">
              Execution: <strong className="text-signal">{planResult.executionTimeMs.toFixed(2)} ms</strong>
            </span>
          ) : null}
        </div>
      </div>

      {/* Planner Findings & Warnings */}
      {planResult.findings && planResult.findings.length > 0 ? (
        <div className="space-y-2">
          {planResult.findings.map((finding, idx) => (
            <div
              key={idx}
              className={`rounded-lg border p-2.5 text-xs flex items-center gap-2 ${
                finding.severity === 'warn'
                  ? 'border-coral/40 bg-coral/10 text-coral'
                  : 'border-signal/40 bg-signal/10 text-signal'
              }`}
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{finding.message}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Visual Execution Tree */}
      <div className="space-y-2">
        <span className="text-[11px] font-sans font-semibold text-muted uppercase tracking-wider">
          Query Execution Tree
        </span>
        {planNode ? (
          <PlanNodeItem node={planNode} depth={0} isAnalyzed={planResult.analyzed} />
        ) : (
          <div className="p-4 text-muted">No plan node tree available.</div>
        )}
      </div>

      {/* Raw JSON Accordion */}
      <details className="rounded-lg border border-edge bg-panel p-3">
        <summary className="cursor-pointer text-xs font-sans text-muted hover:text-body">
          View Raw PostgreSQL Plan JSON
        </summary>
        <pre className="mt-2 text-[11px] text-muted overflow-auto max-h-60 bg-raised/40 p-2 rounded">
          {JSON.stringify(planResult.plan, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function PlanNodeItem({
  node,
  depth,
  isAnalyzed,
}: {
  node: Record<string, unknown>;
  depth: number;
  isAnalyzed: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const nodeType = String(node['Node Type'] ?? 'Unknown Node');
  const relationName = node['Relation Name'] as string | undefined;
  const indexName = node['Index Name'] as string | undefined;
  const totalCost = Number(node['Total Cost'] ?? 0);
  const planRows = Number(node['Plan Rows'] ?? 0);
  const actualRows = node['Actual Rows'] !== undefined ? Number(node['Actual Rows']) : null;
  const actualTime = node['Actual Total Time'] !== undefined ? Number(node['Actual Total Time']) : null;
  const plans = (node['Plans'] as Record<string, unknown>[]) || [];

  const isSeqScan = nodeType.toLowerCase().includes('seq scan');
  const isIndexScan = nodeType.toLowerCase().includes('index');

  return (
    <div style={{ marginLeft: `${depth * 20}px` }} className="space-y-1.5">
      <div
        className={`rounded-lg border p-2.5 transition-colors flex items-center justify-between gap-3 ${
          isSeqScan
            ? 'border-coral/40 bg-coral/5 hover:bg-coral/10'
            : isIndexScan
            ? 'border-mint/40 bg-mint/5 hover:bg-mint/10'
            : 'border-edge bg-panel hover:bg-raised/40'
        }`}
      >
        <div className="flex items-center gap-2">
          {plans.length > 0 ? (
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="p-0.5 text-muted hover:text-body rounded hover:bg-raised"
            >
              {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          ) : (
            <div className="w-4" />
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-body text-xs">{nodeType}</span>
            {relationName ? (
              <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-signal border border-edge">
                on {relationName}
              </span>
            ) : null}
            {indexName ? (
              <span className="rounded bg-mint/15 px-1.5 py-0.5 text-[10px] text-mint border border-mint/30">
                idx: {indexName}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-3 text-[11px] text-muted">
          <span>Cost: {totalCost.toFixed(1)}</span>
          <span>Rows: {actualRows !== null ? `${actualRows} (est: ${planRows})` : planRows}</span>
          {actualTime !== null ? <span className="text-signal font-semibold">{actualTime.toFixed(2)} ms</span> : null}
        </div>
      </div>

      {!collapsed && plans.length > 0 ? (
        <div className="space-y-1.5 border-l-2 border-edge/60 pl-2">
          {plans.map((child, idx) => (
            <PlanNodeItem key={idx} node={child} depth={depth + 1} isAnalyzed={isAnalyzed} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   4. DATABASE DIAGNOSTICS PANEL (Live Connections, Locks, Cache Hit, Stats)
───────────────────────────────────────────────────────────── */
interface DatabaseDiagnosticsPanelProps {
  diagnostics: DiagnosticsData;
  onCancelQuery: (pid: number) => void;
  onRefresh: () => void;
}

export function DatabaseDiagnosticsPanel({
  diagnostics,
  onCancelQuery,
  onRefresh,
}: DatabaseDiagnosticsPanelProps) {
  const [tab, setTab] = useState<'connections' | 'locks' | 'tables' | 'slow'>('connections');

  return (
    <div className="flex flex-col h-full bg-sheet text-body font-mono text-xs">
      {/* Header bar with summary metric badges */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-4 py-2.5 bg-panel">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 rounded-lg border border-edge bg-sheet p-0.5">
            <button
              onClick={() => setTab('connections')}
              className={`px-2.5 py-1 rounded text-[11px] font-sans font-medium transition-colors ${
                tab === 'connections' ? 'bg-raised text-signal shadow-sm' : 'text-muted hover:text-body'
              }`}
            >
              Connections ({diagnostics.connections.length})
            </button>
            <button
              onClick={() => setTab('locks')}
              className={`px-2.5 py-1 rounded text-[11px] font-sans font-medium transition-colors ${
                tab === 'locks' ? 'bg-raised text-signal shadow-sm' : 'text-muted hover:text-body'
              }`}
            >
              Lock Conflicts ({diagnostics.locks.length})
            </button>
            <button
              onClick={() => setTab('tables')}
              className={`px-2.5 py-1 rounded text-[11px] font-sans font-medium transition-colors ${
                tab === 'tables' ? 'bg-raised text-signal shadow-sm' : 'text-muted hover:text-body'
              }`}
            >
              Table Sizes ({diagnostics.tables.length})
            </button>
            <button
              onClick={() => setTab('slow')}
              className={`px-2.5 py-1 rounded text-[11px] font-sans font-medium transition-colors ${
                tab === 'slow' ? 'bg-raised text-signal shadow-sm' : 'text-muted hover:text-body'
              }`}
            >
              Slow Queries ({diagnostics.slowQueries.length})
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-muted">Cache Hit Ratio:</span>
            <span className="font-semibold text-mint">{diagnostics.cacheHitRatio}%</span>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-muted">Commits:</span>
            <span className="font-semibold text-body">{diagnostics.commits.toLocaleString()}</span>
          </div>
          <button
            onClick={onRefresh}
            className="flex items-center gap-1 rounded border border-edge bg-raised px-2 py-1 text-[11px] text-muted hover:text-body hover:bg-edge transition-colors"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
      </div>

      {/* Main tab content */}
      <div className="flex-1 overflow-auto p-4">
        {tab === 'connections' ? (
          <div className="space-y-3">
            <span className="text-xs text-muted block font-sans">
              Active PostgreSQL server processes connected to this database. You can cancel long-running queries immediately.
            </span>
            <table className="w-full border-collapse text-left">
              <thead className="bg-raised border-b border-edge text-[10px] text-muted font-normal">
                <tr>
                  <th className="px-2 py-1.5">PID</th>
                  <th className="px-2 py-1.5">User</th>
                  <th className="px-2 py-1.5">Client IP</th>
                  <th className="px-2 py-1.5">State</th>
                  <th className="px-2 py-1.5">Duration</th>
                  <th className="px-3 py-1.5">Query</th>
                  <th className="px-2 py-1.5 text-center">Action</th>
                </tr>
              </thead>
              <tbody>
                {diagnostics.connections.map((conn) => (
                  <tr key={conn.pid} className="border-b border-edge/40 hover:bg-raised/30 transition-colors">
                    <td className="px-2 py-1.5 font-bold text-signal">{conn.pid}</td>
                    <td className="px-2 py-1.5 text-body">{conn.usename}</td>
                    <td className="px-2 py-1.5 text-muted">{conn.client_addr || 'local / socket'}</td>
                    <td className="px-2 py-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] uppercase font-bold ${
                          conn.state === 'active' ? 'bg-mint/20 text-mint' : 'bg-raised text-muted'
                        }`}
                      >
                        {conn.state}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-muted">{conn.duration_seconds}s</td>
                    <td className="px-3 py-1.5 max-w-md truncate text-muted group-hover:text-body">
                      {conn.query || '<idle>'}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onCancelQuery(conn.pid)}
                        className="h-6 text-[10px] text-coral hover:bg-coral/10 border border-coral/30"
                      >
                        Cancel Query
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : tab === 'locks' ? (
          <div className="space-y-3">
            <span className="text-xs text-muted block font-sans">
              Blocked queries waiting on ungranted table locks or transactions.
            </span>
            {diagnostics.locks.length === 0 ? (
              <div className="p-8 text-center text-muted">
                <Check className="h-6 w-6 text-mint mx-auto mb-2" />
                No lock contentions or blocked transactions detected in PostgreSQL.
              </div>
            ) : (
              <div className="space-y-2">
                {diagnostics.locks.map((lock, idx) => (
                  <div key={idx} className="rounded-lg border border-coral/40 bg-coral/5 p-3 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-coral font-bold">
                        Blocked PID {lock.blocked_pid} waiting on Blocking PID {lock.blocking_pid}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onCancelQuery(lock.blocking_pid)}
                        className="h-6 text-[10px] text-coral hover:bg-coral/20 border border-coral/40"
                      >
                        Terminate Blocking PID ({lock.blocking_pid})
                      </Button>
                    </div>
                    <div className="space-y-1 text-[11px]">
                      <div>
                        <span className="text-muted">Blocked Statement:</span>
                        <pre className="rounded bg-raised p-1.5 text-body overflow-x-auto">{lock.blocked_statement}</pre>
                      </div>
                      <div>
                        <span className="text-muted">Blocking Statement:</span>
                        <pre className="rounded bg-raised p-1.5 text-coral overflow-x-auto">{lock.blocking_statement}</pre>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : tab === 'tables' ? (
          <div className="space-y-3">
            <span className="text-xs text-muted block font-sans">
              Disk utilization & tuple statistics across user tables (from pg_stat_user_tables).
            </span>
            <table className="w-full border-collapse text-left">
              <thead className="bg-raised border-b border-edge text-[10px] text-muted font-normal">
                <tr>
                  <th className="px-3 py-1.5">Table Name</th>
                  <th className="px-3 py-1.5">Live Rows</th>
                  <th className="px-3 py-1.5">Dead Tuples</th>
                  <th className="px-3 py-1.5">Table Disk Size</th>
                  <th className="px-3 py-1.5">Index Disk Size</th>
                  <th className="px-3 py-1.5">Total Size</th>
                </tr>
              </thead>
              <tbody>
                {diagnostics.tables.map((tbl) => (
                  <tr key={tbl.table_name} className="border-b border-edge/40 hover:bg-raised/30 transition-colors">
                    <td className="px-3 py-1.5 font-bold text-body">{tbl.table_name}</td>
                    <td className="px-3 py-1.5 text-signal">{tbl.live_rows.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-muted">{tbl.dead_rows.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-muted">{formatBytes(tbl.table_bytes)}</td>
                    <td className="px-3 py-1.5 text-muted">{formatBytes(tbl.index_bytes)}</td>
                    <td className="px-3 py-1.5 font-semibold text-mint">{formatBytes(tbl.total_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          /* SLOW QUERIES */
          <div className="space-y-3">
            <span className="text-xs text-muted block font-sans">
              Recorded queries taking over 500ms to execute on the server.
            </span>
            {diagnostics.slowQueries.length === 0 ? (
              <div className="p-8 text-center text-muted">
                <Check className="h-6 w-6 text-mint mx-auto mb-2" />
                No slow queries exceeding 500ms detected.
              </div>
            ) : (
              <div className="space-y-2">
                {diagnostics.slowQueries.map((sq) => (
                  <div key={sq.id} className="rounded-lg border border-edge bg-panel p-3 space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-coral font-bold">{parseFloat(String(sq.duration_ms)).toFixed(2)} ms</span>
                      <span className="text-muted text-[10px]">{new Date(sq.created_at).toLocaleString()}</span>
                    </div>
                    <pre className="rounded bg-raised/40 p-2 text-[11px] text-body overflow-x-auto">{sq.query}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   5. CREATE TABLE MODAL (GUI SQL Generator)
───────────────────────────────────────────────────────────── */
interface CreateTableModalProps {
  onClose: () => void;
  onApply: (sql: string) => void;
}

export function CreateTableModal({ onClose, onApply }: CreateTableModalProps) {
  const [tableName, setTableName] = useState('');
  const [columns, setColumns] = useState<
    { name: string; type: string; isPk: boolean; isNullable: boolean; defaultValue: string }[]
  >([
    { name: 'id', type: 'UUID', isPk: true, isNullable: false, defaultValue: 'gen_random_uuid()' },
    { name: 'name', type: 'TEXT', isPk: false, isNullable: false, defaultValue: '' },
    { name: 'created_at', type: 'TIMESTAMPTZ', isPk: false, isNullable: false, defaultValue: 'now()' },
  ]);

  const generatedSql = useMemo(() => {
    const cleanName = tableName.trim() || 'new_table';
    const colsSql = columns.map((col) => {
      let def = `  ${col.name.trim() || 'col'} ${col.type}`;
      if (col.isPk) def += ' PRIMARY KEY';
      if (!col.isNullable && !col.isPk) def += ' NOT NULL';
      if (col.defaultValue.trim()) def += ` DEFAULT ${col.defaultValue.trim()}`;
      return def;
    });
    return `CREATE TABLE ${cleanName} (\n${colsSql.join(',\n')}\n);`;
  }, [tableName, columns]);

  const addColumn = () => {
    setColumns([...columns, { name: '', type: 'TEXT', isPk: false, isNullable: true, defaultValue: '' }]);
  };

  const removeColumn = (index: number) => {
    setColumns(columns.filter((_, i) => i !== index));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-full max-w-xl rounded-2xl border border-edge bg-panel p-5 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-edge pb-2">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-signal" />
            <h3 className="font-semibold text-body text-sm">Visual Table Generator</h3>
          </div>
          <button onClick={onClose} className="text-muted hover:text-body">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          <div>
            <label className="text-[11px] text-muted block mb-1">Table Name:</label>
            <Input
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              placeholder="e.g. products, customers, orders"
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-body">Columns</span>
              <Button size="sm" variant="ghost" onClick={addColumn} className="h-7 text-xs border border-edge">
                <Plus className="h-3 w-3" /> Add Column
              </Button>
            </div>

            <div className="space-y-2">
              {columns.map((col, idx) => (
                <div key={idx} className="flex items-center gap-2 rounded-lg border border-edge bg-sheet p-2 text-xs">
                  <Input
                    value={col.name}
                    onChange={(e) => {
                      const updated = [...columns];
                      updated[idx].name = e.target.value;
                      setColumns(updated);
                    }}
                    placeholder="Column Name"
                    className="w-1/3 h-7 font-mono text-xs"
                  />
                  <select
                    value={col.type}
                    onChange={(e) => {
                      const updated = [...columns];
                      updated[idx].type = e.target.value;
                      setColumns(updated);
                    }}
                    className="w-1/4 h-7 rounded border border-edge bg-raised px-1 py-0.5 text-xs text-body"
                  >
                    <option value="UUID">UUID</option>
                    <option value="TEXT">TEXT</option>
                    <option value="VARCHAR(255)">VARCHAR(255)</option>
                    <option value="INTEGER">INTEGER</option>
                    <option value="BIGINT">BIGINT</option>
                    <option value="NUMERIC">NUMERIC</option>
                    <option value="BOOLEAN">BOOLEAN</option>
                    <option value="TIMESTAMPTZ">TIMESTAMPTZ</option>
                    <option value="JSONB">JSONB</option>
                  </select>
                  <label className="flex items-center gap-1 text-[10px] text-muted cursor-pointer">
                    <input
                      type="checkbox"
                      checked={col.isPk}
                      onChange={(e) => {
                        const updated = [...columns];
                        updated[idx].isPk = e.target.checked;
                        setColumns(updated);
                      }}
                      className="rounded"
                    />
                    PK
                  </label>
                  <Input
                    value={col.defaultValue}
                    onChange={(e) => {
                      const updated = [...columns];
                      updated[idx].defaultValue = e.target.value;
                      setColumns(updated);
                    }}
                    placeholder="Default Value"
                    className="w-1/4 h-7 font-mono text-[11px]"
                  />
                  <button
                    onClick={() => removeColumn(idx)}
                    disabled={columns.length === 1}
                    className="text-muted hover:text-coral disabled:opacity-30 p-1"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <span className="text-[10px] text-muted uppercase font-semibold tracking-wider">
              Generated SQL Preview:
            </span>
            <pre className="mt-1 rounded bg-raised p-2.5 text-[11px] font-mono text-signal overflow-x-auto border border-edge">
              {generatedSql}
            </pre>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-edge">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onApply(generatedSql);
              onClose();
            }}
          >
            Load into Editor
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   6. SCHEMA DIFF & MIGRATION PREVIEW MODAL
───────────────────────────────────────────────────────────── */
interface SchemaDiffModalProps {
  catalog: SchemaCatalog | null;
  onClose: () => void;
  onApplySql: (sql: string) => void;
}

export function SchemaDiffModal({ catalog, onClose, onApplySql }: SchemaDiffModalProps) {
  const [migrationScript, setMigrationScript] = useState<string>(() => {
    return `-- KairosDB Generated Schema Migration\n-- Target Host: Laptop A PostgreSQL 17\n\nALTER TABLE posts\n  ADD COLUMN IF NOT EXISTS view_count BIGINT DEFAULT 0;\n\nCREATE INDEX IF NOT EXISTS posts_view_count_idx\n  ON posts (view_count DESC);`;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-full max-w-xl rounded-2xl border border-edge bg-panel p-5 shadow-2xl space-y-4 max-h-[85vh] flex flex-col font-mono text-xs">
        <div className="flex items-center justify-between border-b border-edge pb-2 font-sans">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-mint" />
            <h3 className="font-semibold text-body text-sm">Schema Migration Generator</h3>
          </div>
          <button onClick={onClose} className="text-muted hover:text-body">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          <p className="text-muted font-sans text-xs">
            Review and apply transactional DDL migrations directly to the remote server host database.
          </p>

          <div className="rounded-lg border border-edge bg-sheet p-2.5 space-y-1 text-[11px]">
            <span className="text-muted block">Catalog Summary:</span>
            <span className="text-body font-semibold">
              {catalog?.tables.length ?? 0} Tables · {catalog?.functions.length ?? 0} Functions · {catalog?.indexes.length ?? 0} Indexes
            </span>
          </div>

          <div>
            <label className="text-[11px] text-muted block mb-1 font-sans">Migration SQL Script:</label>
            <textarea
              value={migrationScript}
              onChange={(e) => setMigrationScript(e.target.value)}
              rows={8}
              className="w-full rounded-lg border border-edge bg-raised/40 p-2.5 font-mono text-xs text-body focus:border-signal focus:outline-none"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-edge font-sans">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onApplySql(migrationScript);
              onClose();
            }}
          >
            Apply to Database
          </Button>
        </div>
      </div>
    </div>
  );
}
