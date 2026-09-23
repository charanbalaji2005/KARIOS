'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { use, useEffect, useState } from 'react';
import { api, session } from '@/lib/api';
import { Alert, Button, Empty, Field, Input, Skeleton } from '@/components/ui';
import {
  AlertTriangle,
  Database,
  Download,
  FileSpreadsheet,
  Key,
  Link as LinkIcon,
  Lock,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

interface TableSummary {
  name: string;
  schema: string;
  rls_enabled: boolean;
  estimated_rows: number;
  size_bytes: number;
  column_count: number;
}

interface RowsResponse {
  data: Record<string, unknown>[];
  meta: { total: number; fields: string[]; limit: number; offset: number };
}

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default_value: string | null;
  position: number;
  comment: string | null;
  is_primary_key: boolean;
}

interface TableDetail {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  constraints: { name: string; type: string; definition: string }[];
  indexes: { name: string; definition: string }[];
  policies: unknown[];
}

interface Relationship {
  name: string;
  source_schema: string;
  source_table: string;
  source_column: string;
  target_schema: string;
  target_table: string;
  target_column: string;
}

function ForeignKeyPicker({
  refId,
  targetTable,
  targetColumn,
  value,
  isNullable,
  onSelect,
}: {
  refId: string;
  targetTable: string;
  targetColumn: string;
  value: string;
  isNullable: boolean;
  onSelect: (val: string) => void;
}) {
  const targetRows = useQuery({
    queryKey: ['fk-lookup', refId, targetTable],
    queryFn: () =>
      api<RowsResponse>(`/api/v1/projects/${refId}/database/tables/${targetTable}/rows?limit=30`).catch(() => null),
  });

  const rows = targetRows.data?.data ?? [];

  if (targetRows.isLoading) {
    return <span className="text-[10px] text-muted italic">Loading records from {targetTable}…</span>;
  }

  if (rows.length === 0) {
    return (
      <div className="rounded bg-coral/10 border border-coral/30 px-2 py-1 text-[11px] text-coral flex items-center justify-between">
        <span>Table &quot;{targetTable}&quot; has no rows yet to reference.</span>
        {isNullable ? <span className="text-[10px] text-muted">(Leave blank for NULL)</span> : null}
      </div>
    );
  }

  const getLabel = (row: Record<string, unknown>) => {
    const idVal = String(row[targetColumn] ?? '');
    const displayVal = row.name ?? row.email ?? row.username ?? row.title ?? row.action ?? '';
    if (displayVal) {
      return `${String(displayVal)} (${idVal.slice(0, 8)}…)`;
    }
    return idVal.length > 20 ? `${idVal.slice(0, 18)}…` : idVal;
  };

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted flex items-center gap-1">
          <span>Select from <strong>{targetTable}</strong> ({rows.length} rows):</span>
        </span>
        {isNullable ? (
          <button
            type="button"
            onClick={() => onSelect('')}
            className="text-[10px] text-signal/80 hover:text-signal hover:underline"
          >
            Clear (Set NULL)
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1.5 rounded bg-raised/40 border border-edge/60">
        {rows.map((row, idx) => {
          const val = String(row[targetColumn] ?? '');
          const isSelected = value === val;
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onSelect(val)}
              className={`rounded px-2 py-0.5 text-[10px] font-mono transition-colors border ${
                isSelected
                  ? 'bg-signal text-black border-signal font-bold'
                  : 'bg-raised text-body border-edge hover:border-signal/50 hover:text-signal'
              }`}
            >
              {getLabel(row)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const BLANK_COLUMN = { name: '', type: 'text', nullable: true, primaryKey: false, unique: false, default: '' };

export default function TableEditorPage({ params }: { params: Promise<{ ref: string }> | { ref: string } }) {
  const { ref } = params instanceof Promise ? use(params) : params;
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [tableName, setTableName] = useState('');
  const [columns, setColumns] = useState([
    { ...BLANK_COLUMN, name: 'id', type: 'uuid', primaryKey: true, nullable: false, default: 'gen_random_uuid()' },
    { ...BLANK_COLUMN, name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()' },
  ]);

  // Insert row modal state
  const [showInsertRow, setShowInsertRow] = useState(false);
  const [insertValues, setInsertValues] = useState<Record<string, string>>({});
  const [useDefaults, setUseDefaults] = useState<Record<string, boolean>>({});
  const [setNulls, setSetNulls] = useState<Record<string, boolean>>({});
  const [insertError, setInsertError] = useState<string | null>(null);

  // Add column modal state
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [newColType, setNewColType] = useState('text');
  const [newColNullable, setNewColNullable] = useState(true);
  const [newColUnique, setNewColUnique] = useState(false);
  const [newColDefault, setNewColDefault] = useState('');
  const [addColumnError, setAddColumnError] = useState<string | null>(null);

  // Edit table modal state
  const [showEditTable, setShowEditTable] = useState(false);
  const [editTableName, setEditTableName] = useState('');
  const [editTableRls, setEditTableRls] = useState(true);
  const [editTableError, setEditTableError] = useState<string | null>(null);

  // Delete table modal state
  const [showDeleteTable, setShowDeleteTable] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteCascade, setDeleteCascade] = useState(false);
  const [deleteTableError, setDeleteTableError] = useState<string | null>(null);

  // Import modal state
  const [showImport, setShowImport] = useState(false);
  const [importFormat, setImportFormat] = useState<'csv' | 'json'>('csv');
  const [importContent, setImportContent] = useState('');
  const [importMode, setImportMode] = useState<'insert' | 'upsert'>('insert');
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Secure export modal state
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exportScope, setExportScope] = useState<'selected' | 'all'>('selected');
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);

  const tables = useQuery({
    queryKey: ['tables', ref],
    queryFn: () => api<TableSummary[]>(`/api/v1/projects/${ref}/database/tables`),
  });

  const tableDetail = useQuery({
    queryKey: ['table-detail', ref, selected],
    enabled: Boolean(selected),
    queryFn: () => api<TableDetail>(`/api/v1/projects/${ref}/database/tables/${selected}`),
  });

  const relationships = useQuery({
    queryKey: ['relationships', ref],
    queryFn: () =>
      api<Relationship[]>(`/api/v1/projects/${ref}/database/relationships`).catch(() => []),
  });

  const rows = useQuery({
    queryKey: ['rows', ref, selected, page],
    enabled: Boolean(selected),
    queryFn: () =>
      api<RowsResponse>(`/api/v1/projects/${ref}/database/tables/${selected}/rows?limit=25&offset=${page * 25}`),
  });

  const createTable = useMutation({
    mutationFn: () =>
      api(`/api/v1/projects/${ref}/database/tables`, {
        method: 'POST',
        body: JSON.stringify({
          name: tableName,
          columns: columns.filter((c) => c.name.trim()).map((c) => ({ ...c, default: c.default || undefined })),
          enableRls: true,
          enableRealtime: true,
        }),
      }),
    onSuccess: () => {
      setShowCreate(false);
      setTableName('');
      void queryClient.invalidateQueries({ queryKey: ['tables', ref] });
    },
  });

  const addColumn = useMutation({
    mutationFn: async () => {
      if (!newColName.trim()) {
        throw new Error('Column name is required');
      }
      return api(`/api/v1/projects/${ref}/database/tables/${selected}/columns`, {
        method: 'POST',
        body: JSON.stringify({
          name: newColName.trim(),
          type: newColType,
          nullable: newColNullable,
          unique: newColUnique,
          default: newColDefault.trim() || undefined,
        }),
      });
    },
    onSuccess: () => {
      setShowAddColumn(false);
      setNewColName('');
      setNewColDefault('');
      setNewColNullable(true);
      setNewColUnique(false);
      setAddColumnError(null);
      void queryClient.invalidateQueries({ queryKey: ['table-detail', ref, selected] });
      void queryClient.invalidateQueries({ queryKey: ['rows', ref, selected] });
      void queryClient.invalidateQueries({ queryKey: ['tables', ref] });
    },
    onError: (err) => {
      setAddColumnError((err as Error).message);
    },
  });

  // Effective columns for the selected table
  const effectiveColumns: ColumnInfo[] =
    tableDetail.data?.columns && tableDetail.data.columns.length > 0
      ? tableDetail.data.columns
      : (rows.data?.meta?.fields ?? []).map((f) => ({
          name: f,
          type: 'text',
          nullable: true,
          default_value: null,
          position: 0,
          comment: null,
          is_primary_key: f === 'id',
        }));

  const openInsertRowModal = () => {
    setInsertError(null);
    const defaults: Record<string, boolean> = {};
    const nulls: Record<string, boolean> = {};
    const vals: Record<string, string> = {};

    effectiveColumns.forEach((col) => {
      defaults[col.name] = Boolean(col.default_value);
      nulls[col.name] = false;
      vals[col.name] = '';
    });

    setUseDefaults(defaults);
    setSetNulls(nulls);
    setInsertValues(vals);
    setShowInsertRow(true);
  };

  const insertRow = useMutation({
    mutationFn: async () => {
      const rowPayload: Record<string, unknown> = {};

      for (const col of effectiveColumns) {
        if (useDefaults[col.name]) {
          // Omit column to let PostgreSQL evaluate column DEFAULT
          continue;
        }
        if (setNulls[col.name]) {
          rowPayload[col.name] = null;
          continue;
        }

        const raw = insertValues[col.name];
        if (raw === undefined || raw === '' || (typeof raw === 'string' && raw.trim() === '')) {
          if (col.nullable) {
            rowPayload[col.name] = null;
          } else if (col.default_value) {
            continue;
          } else {
            throw new Error(`Column "${col.name}" is required. Please provide a value or check default.`);
          }
        } else {
          const lowerType = col.type.toLowerCase();
          if (lowerType === 'boolean') {
            rowPayload[col.name] = raw === 'true' || raw === '1';
          } else if (['integer', 'bigint', 'smallint', 'int', 'int4', 'int8', 'serial', 'bigserial'].some((t) => lowerType.includes(t))) {
            const num = parseInt(raw, 10);
            rowPayload[col.name] = isNaN(num) ? raw : num;
          } else if (['numeric', 'decimal', 'real', 'double precision', 'float', 'float4', 'float8'].some((t) => lowerType.includes(t))) {
            const num = parseFloat(raw);
            rowPayload[col.name] = isNaN(num) ? raw : num;
          } else if (lowerType.includes('json')) {
            try {
              rowPayload[col.name] = JSON.parse(raw);
            } catch {
              rowPayload[col.name] = raw;
            }
          } else {
            rowPayload[col.name] = typeof raw === 'string' ? raw.trim() : raw;
          }
        }
      }

      return await api(`/api/v1/projects/${ref}/database/tables/${selected}/rows`, {
        method: 'POST',
        body: JSON.stringify({ row: rowPayload }),
      });
    },
    onSuccess: () => {
      setShowInsertRow(false);
      setInsertError(null);
      void queryClient.invalidateQueries({ queryKey: ['rows', ref, selected] });
      void queryClient.invalidateQueries({ queryKey: ['tables', ref] });
    },
    onError: (err) => {
      setInsertError((err as Error).message);
    },
  });

  const deleteRow = useMutation({
    mutationFn: async (row: Record<string, unknown>) => {
      const primaryKeyCol = effectiveColumns.find((c) => c.is_primary_key);
      const queryParam =
        primaryKeyCol && row[primaryKeyCol.name] !== undefined && row[primaryKeyCol.name] !== null
          ? `${encodeURIComponent(primaryKeyCol.name)}=eq.${encodeURIComponent(String(row[primaryKeyCol.name]))}`
          : Object.entries(row)
              .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
              .slice(0, 2)
              .map(([k, v]) => `${encodeURIComponent(k)}=eq.${encodeURIComponent(String(v))}`)
              .join('&');

      if (!queryParam) {
        throw new Error('Could not determine unique row identifier to delete');
      }

      return await api(`/api/v1/projects/${ref}/database/tables/${selected}/rows?${queryParam}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rows', ref, selected] });
      void queryClient.invalidateQueries({ queryKey: ['tables', ref] });
    },
  });

  const deleteTable = useMutation({
    mutationFn: async () => {
      return api(`/api/v1/projects/${ref}/database/tables/${selected}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: deleteConfirmText.trim(), cascade: deleteCascade }),
      });
    },
    onSuccess: () => {
      setShowDeleteTable(false);
      setDeleteConfirmText('');
      setDeleteTableError(null);
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: ['tables', ref] });
    },
    onError: (err) => {
      setDeleteTableError((err as Error).message);
    },
  });

  const editTable = useMutation({
    mutationFn: async () => {
      const newName = editTableName.trim();
      return api(`/api/v1/projects/${ref}/database/tables/${selected}`, {
        method: 'PATCH',
        body: JSON.stringify({
          rename: newName && newName !== selected ? newName : undefined,
          enableRls: editTableRls,
        }),
      });
    },
    onSuccess: () => {
      const newName = editTableName.trim();
      setShowEditTable(false);
      setEditTableError(null);
      if (newName && newName !== selected) {
        setSelected(newName);
      }
      void queryClient.invalidateQueries({ queryKey: ['tables', ref] });
      void queryClient.invalidateQueries({ queryKey: ['table-detail', ref] });
    },
    onError: (err) => {
      setEditTableError((err as Error).message);
    },
  });

  const importData = useMutation({
    mutationFn: async () => {
      if (!importContent.trim()) throw new Error('Please select a file or paste data to import');
      return api<{ inserted: number }>(`/api/v1/projects/${ref}/database/tables/${selected}/import`, {
        method: 'POST',
        body: JSON.stringify({
          format: importFormat,
          content: importContent,
          mode: importMode,
          dryRun: false,
        }),
      });
    },
    onSuccess: (res) => {
      setImportResult(`Successfully imported ${res?.inserted ?? 0} rows!`);
      void queryClient.invalidateQueries({ queryKey: ['rows', ref, selected] });
      void queryClient.invalidateQueries({ queryKey: ['tables', ref] });
      setTimeout(() => {
        setShowImport(false);
        setImportContent('');
        setImportResult(null);
      }, 1500);
    },
    onError: (err) => {
      setImportError((err as Error).message);
    },
  });

  async function handleSecureExport(e: React.FormEvent) {
    e.preventDefault();
    setExportError(null);
    setExportLoading(true);
    try {
      const userEmail = session.getUser()?.email ?? 'dev@kairosdb.local';
      // Verify password against /api/v1/auth/login
      await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: userEmail, password: exportPassword }),
      });

      // Dynamically import JSZip
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      const tablesToExport = exportScope === 'selected' && selected
        ? [selected]
        : (tables.data ?? []).map((t) => t.name);

      if (tablesToExport.length === 0) {
        throw new Error('No tables found to export');
      }

      const manifest: Record<string, unknown> = {
        exportDate: new Date().toISOString(),
        projectRef: ref,
        authorizedUser: userEmail,
        securityVerification: 'PASSED',
        tables: {},
      };

      for (const tbl of tablesToExport) {
        const res = await api<RowsResponse>(`/api/v1/projects/${ref}/database/tables/${tbl}/rows?limit=10000`);
        const rowsData = res?.data ?? [];

        // CSV formatting
        const fields = res?.meta?.fields ?? Object.keys(rowsData[0] ?? {});
        const csvLines = [fields.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(',')];
        for (const r of rowsData) {
          csvLines.push(
            fields
              .map((f) => {
                const val = r[f];
                if (val === null || val === undefined) return '';
                return `"${String(val).replace(/"/g, '""')}"`;
              })
              .join(','),
          );
        }
        zip.file(`${tbl}.csv`, csvLines.join('\n'));
        zip.file(`${tbl}.json`, JSON.stringify(rowsData, null, 2));

        (manifest.tables as Record<string, number>)[tbl] = rowsData.length;
      }

      zip.file('security_manifest.json', JSON.stringify(manifest, null, 2));

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${ref}_secure_backup_${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportSuccess(true);
      setTimeout(() => {
        setShowExportModal(false);
        setExportPassword('');
        setExportSuccess(false);
      }, 1500);
    } catch (err: any) {
      setExportError(err?.message ?? 'Password verification failed. Access denied.');
    } finally {
      setExportLoading(false);
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && showInsertRow) {
        setShowInsertRow(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showInsertRow]);

  return (
    <main className="flex h-screen">
      <aside className="w-60 shrink-0 border-r border-edge px-3 py-6 flex flex-col justify-between">
        <div>
          <div className="mb-3 flex items-center justify-between px-1">
            <h2 className="text-sm font-medium text-body">Tables</h2>
            <Button size="sm" variant="primary" onClick={() => setShowCreate(true)}>
              New
            </Button>
          </div>
          {tables.isLoading ? (
            <Skeleton rows={4} />
          ) : (
            <ul className="space-y-0.5">
              {tables.data?.map((table) => (
                <li key={`${table.schema}.${table.name}`}>
                  <button
                    onClick={() => {
                      setSelected(table.name);
                      setPage(0);
                    }}
                    className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                      selected === table.name ? 'bg-raised text-body' : 'text-muted hover:bg-raised hover:text-body'
                    }`}
                  >
                    <span className="font-mono">{table.name}</span>
                    <span className="ml-2 text-xs text-muted">{table.column_count}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="pt-4 border-t border-edge">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setExportScope('all');
              setExportError(null);
              setShowExportModal(true);
            }}
            className="w-full flex items-center justify-center gap-1.5 text-xs text-muted hover:text-body border border-edge"
          >
            <Download className="h-3.5 w-3.5 text-signal" />
            <span>Export Database (ZIP)</span>
          </Button>
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-hidden px-8 py-8">
        {showCreate ? (
          <form
            className="max-w-2xl space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              createTable.mutate();
            }}
          >
            <h1 className="text-lg font-semibold text-body">Create a table</h1>
            <Field label="Name">
              <Input value={tableName} onChange={(e) => setTableName(e.target.value)} required placeholder="posts" />
            </Field>

            <div className="space-y-2">
              <p className="text-sm text-body">Columns</p>
              {columns.map((column, index) => (
                <div key={index} className="flex gap-2">
                  <Input
                    placeholder="name"
                    value={column.name}
                    onChange={(e) => setColumns(columns.map((c, i) => (i === index ? { ...c, name: e.target.value } : c)))}
                  />
                  <select
                    value={column.type}
                    onChange={(e) => setColumns(columns.map((c, i) => (i === index ? { ...c, type: e.target.value } : c)))}
                    className="rounded border border-edge bg-raised px-2 text-sm text-body"
                  >
                    {['uuid', 'text', 'integer', 'bigint', 'numeric', 'boolean', 'timestamptz', 'date', 'jsonb', 'vector(1536)'].map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 whitespace-nowrap text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={!column.nullable}
                      onChange={(e) => setColumns(columns.map((c, i) => (i === index ? { ...c, nullable: !e.target.checked } : c)))}
                    />
                    required
                  </label>
                </div>
              ))}
              <Button type="button" size="sm" onClick={() => setColumns([...columns, { ...BLANK_COLUMN }])}>
                Add column
              </Button>
            </div>

            {createTable.isError ? <Alert>{(createTable.error as Error).message}</Alert> : null}

            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={createTable.isPending}>
                {createTable.isPending ? 'Creating…' : 'Create table'}
              </Button>
              <Button type="button" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : !selected ? (
          <Empty title="Pick a table" description="Choose a table on the left to browse its rows, or create a new one." />
        ) : (
          <>
            <header className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h1 className="font-mono text-lg font-semibold text-body">{selected}</h1>
                <span className="rounded-full bg-raised px-2.5 py-0.5 text-xs text-muted border border-edge">
                  {rows.data?.meta?.total ?? 0} {rows.data?.meta?.total === 1 ? 'row' : 'rows'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => rows.refetch()}
                  title="Refresh rows"
                  className="px-2"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${rows.isFetching ? 'animate-spin' : ''}`} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setImportError(null);
                    setImportResult(null);
                    setShowImport(true);
                  }}
                  className="flex items-center gap-1.5 border border-edge"
                  title="Import data (CSV / JSON)"
                >
                  <Upload className="h-3.5 w-3.5" />
                  <span>Import</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setExportScope('selected');
                    setExportError(null);
                    setShowExportModal(true);
                  }}
                  className="flex items-center gap-1.5 border border-edge"
                  title="Secure Export as ZIP (Requires Password)"
                >
                  <Download className="h-3.5 w-3.5 text-signal" />
                  <span>Export ZIP</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditTableName(selected);
                    setEditTableRls(true);
                    setEditTableError(null);
                    setShowEditTable(true);
                  }}
                  className="flex items-center gap-1.5 border border-edge"
                  title="Edit table (Rename, RLS)"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  <span>Edit table</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDeleteConfirmText('');
                    setDeleteTableError(null);
                    setShowDeleteTable(true);
                  }}
                  className="flex items-center gap-1.5 border border-edge text-coral/80 hover:text-coral"
                  title="Delete table"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Delete</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAddColumnError(null);
                    setShowAddColumn(true);
                  }}
                  className="flex items-center gap-1.5 border border-edge"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add column</span>
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={openInsertRowModal}
                  className="flex items-center gap-1.5"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Insert row</span>
                </Button>
              </div>
            </header>

            {rows.isLoading ? (
              <Skeleton rows={6} />
            ) : rows.isError ? (
              <Alert>{(rows.error as Error).message}</Alert>
            ) : (
              <div className="scroller rounded-lg border border-edge overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="bg-raised">
                    <tr>
                      <th className="w-10 px-3 py-2 text-xs font-mono text-muted"></th>
                      {(rows.data?.meta?.fields ?? []).map((field) => {
                        const colMeta = effectiveColumns.find((c) => c.name === field);
                        return (
                          <th key={field} className="whitespace-nowrap border-b border-edge px-3 py-2 font-mono text-xs text-muted">
                            <div className="flex items-center gap-1.5">
                              <span>{field}</span>
                              {colMeta?.is_primary_key ? (
                                <span className="rounded bg-signal/20 px-1 py-0.2 text-[9px] font-mono text-signal">PK</span>
                              ) : null}
                              {colMeta?.type ? (
                                <span className="text-[10px] text-muted/60 font-normal">({colMeta.type})</span>
                              ) : null}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {(rows.data?.data ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={(rows.data?.meta?.fields ?? []).length + 1} className="py-16 text-center">
                          <div className="flex flex-col items-center justify-center gap-3">
                            <Database className="h-10 w-10 text-muted/40" />
                            <div>
                              <p className="text-sm font-medium text-body">No rows in {selected}</p>
                              <p className="mt-1 text-xs text-muted max-w-sm">
                                This table is currently empty. Insert your first row to store data in it.
                              </p>
                            </div>
                            <Button size="sm" variant="primary" onClick={openInsertRowModal} className="mt-2 flex items-center gap-1.5">
                              <Plus className="h-3.5 w-3.5" />
                              <span>Insert first row</span>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      (rows.data?.data ?? []).map((row, index) => (
                        <tr key={index} className="group border-b border-edge last:border-0 hover:bg-raised/50 transition-colors">
                          <td className="w-10 px-3 py-2 text-center">
                            <button
                              onClick={() => {
                                if (window.confirm('Are you sure you want to delete this row?')) {
                                  deleteRow.mutate(row);
                                }
                              }}
                              title="Delete row"
                              className="opacity-0 group-hover:opacity-100 rounded p-1 text-muted hover:text-coral hover:bg-raised transition-all"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                          {(rows.data?.meta?.fields ?? []).map((field) => (
                            <td key={field} className="max-w-xs truncate px-3 py-2 font-mono text-xs text-body">
                              {row[field] === null ? (
                                <span className="text-muted italic">NULL</span>
                              ) : typeof row[field] === 'object' ? (
                                JSON.stringify(row[field])
                              ) : (
                                String(row[field])
                              )}
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(p - 1, 0))}>
                Previous
              </Button>
              <Button
                size="sm"
                disabled={(rows.data?.meta?.total ?? 0) <= (page + 1) * 25}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
              <span className="text-xs text-muted">page {page + 1}</span>
            </div>
          </>
        )}
      </section>

      {/* Insert Row Modal */}
      {showInsertRow ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="max-w-xl w-full bg-panel border border-edge rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-edge px-5 py-3.5 bg-raised/30">
              <div className="flex items-center gap-2">
                <Plus className="h-4 w-4 text-signal" />
                <h2 className="text-sm font-semibold text-body">
                  Insert row into <span className="font-mono text-signal">{selected}</span>
                </h2>
              </div>
              <button
                onClick={() => setShowInsertRow(false)}
                className="rounded p-1 text-muted hover:bg-raised hover:text-body transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Modal Body */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                insertRow.mutate();
              }}
              className="flex flex-col flex-1 overflow-hidden"
            >
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {insertError ? (
                  <div className="rounded-lg bg-coral/10 border border-coral/30 p-3 space-y-2 text-xs">
                    <div className="flex items-center gap-2 text-coral font-semibold">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>{insertError}</span>
                    </div>
                    {insertError.toLowerCase().includes('row-level security') ? (
                      <div className="rounded bg-panel/80 p-2.5 border border-edge space-y-1.5 text-muted">
                        <p className="text-[11px] text-body">
                          <strong>Why this happens:</strong> Row-Level Security (RLS) is enabled on <code className="text-signal">{selected}</code>, but no security policy exists to permit row inserts. PostgreSQL blocks all operations by default until a policy is added or RLS is disabled.
                        </p>
                        <div className="flex items-center gap-2 pt-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="primary"
                            onClick={() => {
                              api(`/api/v1/projects/${ref}/database/tables/${selected}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ enableRls: false }),
                              })
                                .then(() => {
                                  setInsertError(null);
                                  insertRow.mutate();
                                })
                                .catch((e: Error) => setInsertError(e.message));
                            }}
                            className="text-xs"
                          >
                            Disable RLS &amp; Retry Insert
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <p className="text-xs text-muted">
                  Fill in the columns below. For columns with defaults (like IDs or timestamps), leaving &quot;Use default&quot; checked lets the database generate the value automatically.
                </p>

                <div className="space-y-4 divide-y divide-edge/50">
                  {effectiveColumns.map((col) => {
                    const isDefaultChecked = useDefaults[col.name] ?? Boolean(col.default_value);
                    const isNullChecked = setNulls[col.name] ?? false;
                    const lowerType = col.type.toLowerCase();
                    const fkRel = relationships.data?.find(
                      (r) => r.source_table === selected && r.source_column === col.name
                    );

                    return (
                      <div key={col.name} className="pt-3 first:pt-0 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-semibold text-body">{col.name}</span>
                            {col.is_primary_key ? (
                              <span className="inline-flex items-center gap-0.5 rounded bg-signal/20 px-1.5 py-0.5 text-[9px] font-mono font-medium text-signal">
                                <Key className="h-2.5 w-2.5" /> PK
                              </span>
                            ) : null}
                            {fkRel ? (
                              <span className="inline-flex items-center gap-1 rounded bg-signal/15 px-1.5 py-0.5 text-[9px] font-mono font-medium text-signal border border-signal/30">
                                <LinkIcon className="h-2.5 w-2.5" /> FK &rarr; {fkRel.target_table}.{fkRel.target_column}
                              </span>
                            ) : null}
                            <span className="rounded bg-raised px-1.5 py-0.5 text-[9px] font-mono text-muted border border-edge">
                              {col.type}
                            </span>
                            {!col.nullable && !col.default_value ? (
                              <span className="text-[9px] font-medium text-coral">Required</span>
                            ) : null}
                          </div>

                          <div className="flex items-center gap-3">
                            {col.default_value ? (
                              <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer hover:text-body select-none">
                                <input
                                  type="checkbox"
                                  checked={isDefaultChecked}
                                  onChange={(e) =>
                                    setUseDefaults((prev) => ({ ...prev, [col.name]: e.target.checked }))
                                  }
                                  className="rounded border-edge"
                                />
                                <span>
                                  Default: <code className="text-signal text-[10px]">{col.default_value}</code>
                                </span>
                              </label>
                            ) : null}

                            {col.nullable && !col.default_value ? (
                              <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer hover:text-body select-none">
                                <input
                                  type="checkbox"
                                  checked={isNullChecked}
                                  onChange={(e) =>
                                    setSetNulls((prev) => ({ ...prev, [col.name]: e.target.checked }))
                                  }
                                  className="rounded border-edge"
                                />
                                <span>NULL</span>
                              </label>
                            ) : null}
                          </div>
                        </div>

                        {/* Input widget */}
                        {isDefaultChecked ? (
                          <div className="rounded border border-edge/60 bg-raised/40 px-3 py-2 font-mono text-xs text-muted italic">
                            Database will evaluate default: {col.default_value}
                          </div>
                        ) : isNullChecked ? (
                          <div className="rounded border border-edge/60 bg-raised/40 px-3 py-2 font-mono text-xs text-muted italic">
                            NULL
                          </div>
                        ) : fkRel ? (
                          <div className="space-y-1.5">
                            <Input
                              value={insertValues[col.name] ?? ''}
                              onChange={(e) =>
                                setInsertValues((prev) => ({ ...prev, [col.name]: e.target.value }))
                              }
                              placeholder={
                                col.nullable
                                  ? `FK to ${fkRel.target_table}.${fkRel.target_column} (or leave empty for NULL)`
                                  : `FK to ${fkRel.target_table}.${fkRel.target_column} (Required)`
                              }
                              className="font-mono text-xs"
                            />
                            <ForeignKeyPicker
                              refId={ref}
                              targetTable={fkRel.target_table}
                              targetColumn={fkRel.target_column}
                              value={insertValues[col.name] ?? ''}
                              isNullable={col.nullable}
                              onSelect={(val) => setInsertValues((prev) => ({ ...prev, [col.name]: val }))}
                            />
                          </div>
                        ) : lowerType === 'boolean' ? (
                          <select
                            value={insertValues[col.name] ?? 'true'}
                            onChange={(e) =>
                              setInsertValues((prev) => ({ ...prev, [col.name]: e.target.value }))
                            }
                            className="w-full rounded border border-edge bg-raised px-3 py-2 text-xs text-body focus:border-signal focus:outline-none font-mono"
                          >
                            <option value="true">true</option>
                            <option value="false">false</option>
                            {col.nullable && <option value="">NULL</option>}
                          </select>
                        ) : lowerType.includes('json') ? (
                          <textarea
                            rows={3}
                            value={insertValues[col.name] ?? ''}
                            onChange={(e) =>
                              setInsertValues((prev) => ({ ...prev, [col.name]: e.target.value }))
                            }
                            placeholder='{"key": "value"}'
                            className="w-full rounded border border-edge bg-raised px-3 py-2 font-mono text-xs text-body placeholder:text-muted focus:border-signal focus:outline-none"
                          />
                        ) : lowerType === 'uuid' ? (
                          <div className="space-y-1.5">
                            <div className="flex gap-2">
                              <Input
                                value={insertValues[col.name] ?? ''}
                                onChange={(e) =>
                                  setInsertValues((prev) => ({ ...prev, [col.name]: e.target.value }))
                                }
                                placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                                className="font-mono text-xs"
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setInsertValues((prev) => ({ ...prev, [col.name]: crypto.randomUUID() }))
                                }
                                className="whitespace-nowrap text-xs"
                              >
                                Generate
                              </Button>
                            </div>
                          </div>
                        ) : ['timestamptz', 'timestamp', 'date'].some((t) => lowerType.includes(t)) ? (
                          <div className="flex gap-2">
                            <Input
                              value={insertValues[col.name] ?? ''}
                              onChange={(e) =>
                                setInsertValues((prev) => ({ ...prev, [col.name]: e.target.value }))
                              }
                              placeholder={
                                lowerType.includes('date') && !lowerType.includes('time')
                                  ? 'YYYY-MM-DD'
                                  : 'YYYY-MM-DDTHH:MM:SSZ'
                              }
                              className="font-mono text-xs"
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setInsertValues((prev) => ({ ...prev, [col.name]: new Date().toISOString() }))
                              }
                              className="whitespace-nowrap text-xs"
                            >
                              Now
                            </Button>
                          </div>
                        ) : ['int', 'numeric', 'decimal', 'float', 'serial'].some((t) => lowerType.includes(t)) ? (
                          <Input
                            type="number"
                            step="any"
                            value={insertValues[col.name] ?? ''}
                            onChange={(e) =>
                              setInsertValues((prev) => ({ ...prev, [col.name]: e.target.value }))
                            }
                            placeholder="0"
                            className="font-mono text-xs"
                          />
                        ) : (
                          <Input
                            value={insertValues[col.name] ?? ''}
                            onChange={(e) =>
                              setInsertValues((prev) => ({ ...prev, [col.name]: e.target.value }))
                            }
                            placeholder="Enter value…"
                            className="text-xs"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Modal Footer */}
              <div className="border-t border-edge px-5 py-3 bg-raised/20 flex items-center justify-between">
                <span className="text-xs text-muted">
                  {effectiveColumns.length} {effectiveColumns.length === 1 ? 'column' : 'columns'}
                </span>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowInsertRow(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="primary" size="sm" disabled={insertRow.isPending}>
                    {insertRow.isPending ? 'Inserting…' : 'Insert row'}
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* Add Column Modal */}
      {showAddColumn ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-edge bg-sheet p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-edge pb-3">
              <h2 className="text-base font-semibold text-body">
                Add column to <span className="font-mono text-signal">{selected}</span>
              </h2>
              <button
                type="button"
                onClick={() => setShowAddColumn(false)}
                className="rounded p-1 text-muted hover:bg-raised hover:text-body transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                addColumn.mutate();
              }}
              className="space-y-4"
            >
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Column name</label>
                <Input
                  required
                  placeholder="e.g. bio, age, status"
                  value={newColName}
                  onChange={(e) => setNewColName(e.target.value)}
                  autoFocus
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Type</label>
                <select
                  value={newColType}
                  onChange={(e) => setNewColType(e.target.value)}
                  className="w-full rounded border border-edge bg-raised px-3 py-2 text-sm text-body focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {['text', 'varchar', 'integer', 'bigint', 'numeric', 'boolean', 'timestamptz', 'date', 'uuid', 'jsonb', 'vector(1536)'].map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Default value (optional)</label>
                <Input
                  placeholder="e.g. now(), true, 'active', 0"
                  value={newColDefault}
                  onChange={(e) => setNewColDefault(e.target.value)}
                />
              </div>

              <div className="flex gap-4 pt-1">
                <label className="flex items-center gap-2 text-xs text-body cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newColNullable}
                    onChange={(e) => setNewColNullable(e.target.checked)}
                    className="rounded border-edge"
                  />
                  <span>Allow NULL</span>
                </label>

                <label className="flex items-center gap-2 text-xs text-body cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newColUnique}
                    onChange={(e) => setNewColUnique(e.target.checked)}
                    className="rounded border-edge"
                  />
                  <span>Unique constraint</span>
                </label>
              </div>

              {addColumnError ? <Alert>{addColumnError}</Alert> : null}

              <div className="flex justify-end gap-2 pt-2 border-t border-edge">
                <Button type="button" onClick={() => setShowAddColumn(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={addColumn.isPending}>
                  {addColumn.isPending ? 'Adding…' : 'Add column'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      {/* Edit Table Modal */}
      {showEditTable ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-xl border border-edge bg-sheet p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-edge pb-3">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-signal" />
                <h2 className="text-base font-semibold text-body">
                  Edit table <span className="font-mono text-signal">{selected}</span>
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowEditTable(false)}
                className="rounded p-1 text-muted hover:bg-raised hover:text-body transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                editTable.mutate();
              }}
              className="space-y-4"
            >
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Table name</label>
                <Input
                  required
                  placeholder="New table name"
                  value={editTableName}
                  onChange={(e) => setEditTableName(e.target.value)}
                />
              </div>

              <div className="pt-1">
                <label className="flex items-center gap-2 text-xs text-body cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={editTableRls}
                    onChange={(e) => setEditTableRls(e.target.checked)}
                    className="rounded border-edge"
                  />
                  <span>Enable Row Level Security (RLS)</span>
                </label>
                <p className="mt-1 text-[11px] text-muted">
                  When enabled, fine-grained access policies control table row read/write permissions.
                </p>
              </div>

              {editTableError ? <Alert>{editTableError}</Alert> : null}

              <div className="flex justify-end gap-2 pt-3 border-t border-edge">
                <Button type="button" onClick={() => setShowEditTable(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={editTable.isPending}>
                  {editTable.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* Delete Table Modal */}
      {showDeleteTable ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-xl border border-coral/40 bg-sheet p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-edge pb-3">
              <div className="flex items-center gap-2 text-coral">
                <AlertTriangle className="h-4 w-4" />
                <h2 className="text-base font-semibold text-body">
                  Drop table <span className="font-mono text-coral">{selected}</span>
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowDeleteTable(false)}
                className="rounded p-1 text-muted hover:bg-raised hover:text-body transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                deleteTable.mutate();
              }}
              className="space-y-4"
            >
              <div className="rounded-lg bg-coral/10 border border-coral/25 p-3 text-xs text-coral space-y-1">
                <p className="font-semibold">Warning: This action cannot be undone.</p>
                <p>
                  All data, schemas, indexes, and constraints associated with table <strong>{selected}</strong> will be permanently deleted.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted">
                  Type <span className="font-mono font-semibold text-body select-all">{selected}</span> to confirm:
                </label>
                <Input
                  required
                  placeholder={selected ?? ''}
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  autoFocus
                />
              </div>

              <div>
                <label className="flex items-center gap-2 text-xs text-body cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={deleteCascade}
                    onChange={(e) => setDeleteCascade(e.target.checked)}
                    className="rounded border-edge"
                  />
                  <span>CASCADE (drop dependent objects and foreign keys)</span>
                </label>
              </div>

              {deleteTableError ? <Alert>{deleteTableError}</Alert> : null}

              <div className="flex justify-end gap-2 pt-3 border-t border-edge">
                <Button type="button" onClick={() => setShowDeleteTable(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={deleteConfirmText !== selected || deleteTable.isPending}
                  className="bg-coral hover:bg-coral/90 text-white font-medium disabled:opacity-50"
                >
                  {deleteTable.isPending ? 'Dropping…' : 'Drop Table'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* Import Data Modal */}
      {showImport ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-lg rounded-xl border border-edge bg-sheet p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-edge pb-3">
              <div className="flex items-center gap-2">
                <Upload className="h-4 w-4 text-signal" />
                <h2 className="text-base font-semibold text-body">
                  Import data into <span className="font-mono text-signal">{selected}</span>
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowImport(false)}
                className="rounded p-1 text-muted hover:bg-raised hover:text-body transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                importData.mutate();
              }}
              className="space-y-4"
            >
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted">Format</label>
                  <select
                    value={importFormat}
                    onChange={(e) => setImportFormat(e.target.value as 'csv' | 'json')}
                    className="w-full rounded border border-edge bg-raised px-3 py-2 text-xs text-body focus:outline-none"
                  >
                    <option value="csv">CSV (Comma-separated)</option>
                    <option value="json">JSON (Array of objects)</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted">Insert Mode</label>
                  <select
                    value={importMode}
                    onChange={(e) => setImportMode(e.target.value as 'insert' | 'upsert')}
                    className="w-full rounded border border-edge bg-raised px-3 py-2 text-xs text-body focus:outline-none"
                  >
                    <option value="insert">Insert (Fail on duplicate)</option>
                    <option value="upsert">Upsert (Update on duplicate)</option>
                  </select>
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-medium text-muted">Upload file or paste content</label>
                  <label className="cursor-pointer text-xs text-signal hover:underline">
                    Browse file
                    <input
                      type="file"
                      accept={importFormat === 'csv' ? '.csv,text/csv' : '.json,application/json'}
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = (evt) => {
                            setImportContent(String(evt.target?.result ?? ''));
                          };
                          reader.readAsText(file);
                        }
                      }}
                    />
                  </label>
                </div>
                <textarea
                  rows={7}
                  value={importContent}
                  onChange={(e) => setImportContent(e.target.value)}
                  placeholder={
                    importFormat === 'csv'
                      ? 'title,body,published\n"My Post","Hello world",true'
                      : '[{"title": "My Post", "body": "Hello world", "published": true}]'
                  }
                  className="w-full rounded border border-edge bg-raised px-3 py-2 font-mono text-xs text-body placeholder:text-muted focus:border-signal focus:outline-none"
                  required
                />
              </div>

              {importError ? <Alert>{importError}</Alert> : null}
              {importResult ? (
                <div className="rounded-md bg-signal/15 border border-signal/30 p-2.5 text-xs text-signal font-medium">
                  {importResult}
                </div>
              ) : null}

              <div className="flex justify-end gap-2 pt-2 border-t border-edge">
                <Button type="button" onClick={() => setShowImport(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={importData.isPending || !importContent.trim()}>
                  {importData.isPending ? 'Importing…' : 'Import data'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* Secure Data Export Modal (ZIP with Password Verification) */}
      {showExportModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-xl border border-edge bg-sheet p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-edge pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-signal" />
                <h2 className="text-base font-semibold text-body">
                  Secure Data Export (ZIP)
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowExportModal(false)}
                className="rounded p-1 text-muted hover:bg-raised hover:text-body transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSecureExport} className="space-y-4">
              <div className="rounded-lg bg-raised/50 border border-edge p-3 text-xs text-muted space-y-1">
                <div className="flex items-center gap-1.5 text-body font-medium">
                  <Lock className="h-3.5 w-3.5 text-signal" />
                  <span>Data Protection &amp; Security Verification</span>
                </div>
                <p>
                  To secure your database against unauthorized data extraction, KairosDB bundles all table datasets into a ZIP archive and requires you to verify your user password.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Export Scope</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setExportScope('selected')}
                    className={`rounded-lg border px-3 py-2 text-xs text-left transition-all ${
                      exportScope === 'selected'
                        ? 'border-signal bg-signal/10 text-signal font-medium'
                        : 'border-edge bg-raised text-muted hover:text-body'
                    }`}
                  >
                    <div className="font-semibold">Current Table</div>
                    <div className="text-[10px] opacity-80 font-mono truncate">{selected || 'No table selected'}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setExportScope('all')}
                    className={`rounded-lg border px-3 py-2 text-xs text-left transition-all ${
                      exportScope === 'all'
                        ? 'border-signal bg-signal/10 text-signal font-medium'
                        : 'border-edge bg-raised text-muted hover:text-body'
                    }`}
                  >
                    <div className="font-semibold">All Tables</div>
                    <div className="text-[10px] opacity-80">Full Database Archive ({tables.data?.length ?? 0} tables)</div>
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted">
                  Account Password <span className="text-coral">*</span>
                </label>
                <Input
                  type="password"
                  required
                  placeholder="Enter your KairosDB password"
                  value={exportPassword}
                  onChange={(e) => setExportPassword(e.target.value)}
                  autoFocus
                />
                <p className="mt-1 text-[11px] text-muted">
                  Authenticated as: <code className="text-body font-mono">{session.getUser()?.email ?? 'dev@kairosdb.local'}</code>
                </p>
              </div>

              {exportError ? <Alert>{exportError}</Alert> : null}
              {exportSuccess ? (
                <div className="rounded-md bg-signal/15 border border-signal/30 p-2.5 text-xs text-signal font-medium flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" />
                  <span>Password verified! Generating and downloading ZIP archive…</span>
                </div>
              ) : null}

              <div className="flex justify-end gap-2 pt-3 border-t border-edge">
                <Button type="button" onClick={() => setShowExportModal(false)} disabled={exportLoading}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={exportLoading || !exportPassword || (exportScope === 'selected' && !selected)}
                  className="flex items-center gap-1.5"
                >
                  <Download className={`h-3.5 w-3.5 ${exportLoading ? 'animate-bounce' : ''}`} />
                  <span>{exportLoading ? 'Verifying & Packing…' : 'Verify & Export ZIP'}</span>
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </main>
  );
}
