'use client';

import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api, formatBytes } from '@/lib/api';
import { Alert, Button, Input, Panel, Skeleton, StatusDot } from '@/components/ui';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle,
  Database,
  ExternalLink,
  HardDrive,
  Key,
  Layers,
  Lock,
  PauseCircle,
  RefreshCw,
  Search,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  UserCheck,
  Users,
  X,
  Zap,
} from 'lucide-react';

/* ─────────────────────────────────────────────────────────────
   TYPE DEFINITIONS (Matching /api/v1/admin/*)
───────────────────────────────────────────────────────────── */
interface AdminOverview {
  users: { total: number; admins: number; newLast7Days: number };
  organizations: number;
  projects: { total: number; active: number; failed: number };
  usage: { databaseBytes: number; storageBytes: number };
  attention: { quotaViolations24h: number; unverifiedBackups: number };
  connections: { pools: number; totalClients: number; idleClients: number; waitingQueries: number };
}

interface AdminUser {
  id: string;
  email: string;
  full_name: string | null;
  email_verified: boolean;
  is_platform_admin: boolean;
  created_at: string;
  deleted_at: string | null;
  organizations: number;
  mfa_enabled: boolean;
  last_session_at: string | null;
}

interface AdminProject {
  id: string;
  ref: string;
  name: string;
  status: string;
  created_at: string;
  organization: string;
  owner_email: string;
  database_bytes: string | null;
  storage_bytes: string | null;
  table_count: number | null;
  sampled_at: string | null;
}

interface AdminSecurity {
  windowHours: number;
  topActions: { action: string; count: number; last_seen: string }[];
  quotaViolations: { resource: string; count: number; project_ref: string }[];
  tokenReuse: { ip_address: string; attempts: number; last_seen: string }[];
  note: string;
}

/* ─────────────────────────────────────────────────────────────
   PLATFORM ADMIN PAGE
───────────────────────────────────────────────────────────── */
export default function AdminPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'projects' | 'security' | 'operations'>('overview');

  // Search & Filters
  const [userSearch, setUserSearch] = useState('');
  const [securityHours, setSecurityHours] = useState<number>(24);

  // Modals state
  const [adminToggleUser, setAdminToggleUser] = useState<AdminUser | null>(null);
  const [adminToggleReason, setAdminToggleReason] = useState('');
  const [suspendProject, setSuspendProject] = useState<AdminProject | null>(null);
  const [suspendConfirmText, setSuspendConfirmText] = useState('');
  const [suspendReason, setSuspendReason] = useState('');

  // 1. Overview Query
  const overview = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api<AdminOverview>('/api/v1/admin/overview'),
    refetchInterval: 30_000,
  });

  // 2. Users Query
  const users = useQuery({
    queryKey: ['admin-users', userSearch],
    queryFn: () => {
      const q = userSearch.trim() ? `?search=${encodeURIComponent(userSearch.trim())}` : '';
      return api<AdminUser[]>(`/api/v1/admin/users${q}`);
    },
  });

  // 3. Projects Query
  const projects = useQuery({
    queryKey: ['admin-projects'],
    queryFn: () => api<AdminProject[]>('/api/v1/admin/projects'),
  });

  // 4. Security Query
  const security = useQuery({
    queryKey: ['admin-security', securityHours],
    queryFn: () => api<AdminSecurity>(`/api/v1/admin/security?hours=${securityHours}`),
  });

  // Toggle Admin Mutation
  const toggleAdminMutation = useMutation({
    mutationFn: async ({ userId, isAdmin, reason }: { userId: string; isAdmin: boolean; reason?: string }) => {
      return api(`/api/v1/admin/users/${userId}/admin`, {
        method: 'PATCH',
        body: JSON.stringify({ isAdmin, reason }),
      });
    },
    onSuccess: () => {
      setAdminToggleUser(null);
      setAdminToggleReason('');
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
    },
    onError: (err: any) => {
      alert(`Error updating admin role: ${err.message || 'Operation failed'}`);
    },
  });

  // Suspend Project Mutation
  const suspendProjectMutation = useMutation({
    mutationFn: async ({ ref, confirm, reason }: { ref: string; confirm: string; reason: string }) => {
      return api(`/api/v1/admin/projects/${ref}/suspend`, {
        method: 'POST',
        body: JSON.stringify({ confirm, reason }),
      });
    },
    onSuccess: () => {
      setSuspendProject(null);
      setSuspendConfirmText('');
      setSuspendReason('');
      void queryClient.invalidateQueries({ queryKey: ['admin-projects'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
    },
    onError: (err: any) => {
      alert(`Error suspending project: ${err.message || 'Operation failed'}`);
    },
  });

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 font-sans text-body">
      {/* ─────────────────────────────────────────────────────────────
          1. HEADER & OPERATOR STATUS
      ───────────────────────────────────────────────────────────── */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-edge pb-6">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/projects" className="font-mono text-xs text-muted hover:text-body flex items-center gap-1">
              <ArrowLeft className="h-3 w-3" /> Projects
            </Link>
            <span className="text-edge">/</span>
            <span className="font-mono text-xs text-signal font-semibold uppercase tracking-wider">
              Control Plane
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="rounded-lg bg-signal/15 p-2 text-signal border border-signal/30">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-body">Platform Administration</h1>
              <p className="text-xs text-muted">
                Global governance, tenant isolation, security enforcement, and infrastructure health
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/server"
            className="flex items-center gap-1.5 rounded-lg border border-edge bg-raised/60 px-3 py-1.5 text-xs text-muted hover:text-body transition-colors"
          >
            <Server className="h-3.5 w-3.5 text-signal" />
            <span>Host Telemetry</span>
          </Link>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void overview.refetch();
              void users.refetch();
              void projects.refetch();
              void security.refetch();
            }}
            className="h-8 gap-1.5 text-xs border border-edge"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${overview.isFetching ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          2. INCIDENT / ATTENTION BANNER
      ───────────────────────────────────────────────────────────── */}
      {overview.data?.attention && (overview.data.attention.quotaViolations24h > 0 || overview.data.attention.unverifiedBackups > 0) && (
        <div className="mb-6 rounded-xl border border-amber/40 bg-amber/10 p-4 text-xs text-amber flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <div>
              <span className="font-bold text-sm block">System Attention Required</span>
              <span>
                {overview.data.attention.quotaViolations24h} quota violations logged in the last 24h ·{' '}
                {overview.data.attention.unverifiedBackups} unverified database backups detected.
              </span>
            </div>
          </div>
          <button
            onClick={() => setActiveTab('security')}
            className="rounded px-2.5 py-1 bg-amber/20 hover:bg-amber/30 text-amber font-semibold text-xs border border-amber/40 transition-colors"
          >
            Review Security Logs
          </button>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          3. NAVIGATION TABS
      ───────────────────────────────────────────────────────────── */}
      <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-edge pb-2">
        <button
          onClick={() => setActiveTab('overview')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${
            activeTab === 'overview'
              ? 'bg-raised text-signal shadow-sm border border-edge'
              : 'text-muted hover:text-body hover:bg-raised/40'
          }`}
        >
          <Activity className="h-4 w-4" /> Platform Overview
        </button>

        <button
          onClick={() => setActiveTab('users')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${
            activeTab === 'users'
              ? 'bg-raised text-signal shadow-sm border border-edge'
              : 'text-muted hover:text-body hover:bg-raised/40'
          }`}
        >
          <Users className="h-4 w-4" /> Users & Operators
          {overview.data?.users.total ? (
            <span className="rounded bg-signal/20 px-1.5 py-0.2 text-[10px] text-signal font-mono">
              {overview.data.users.total}
            </span>
          ) : null}
        </button>

        <button
          onClick={() => setActiveTab('projects')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${
            activeTab === 'projects'
              ? 'bg-raised text-signal shadow-sm border border-edge'
              : 'text-muted hover:text-body hover:bg-raised/40'
          }`}
        >
          <Database className="h-4 w-4" /> All Projects
          {overview.data?.projects.total ? (
            <span className="rounded bg-mint/20 px-1.5 py-0.2 text-[10px] text-mint font-mono">
              {overview.data.projects.total}
            </span>
          ) : null}
        </button>

        <button
          onClick={() => setActiveTab('security')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${
            activeTab === 'security'
              ? 'bg-raised text-signal shadow-sm border border-edge'
              : 'text-muted hover:text-body hover:bg-raised/40'
          }`}
        >
          <ShieldAlert className="h-4 w-4" /> Security & Audit
        </button>

        <button
          onClick={() => setActiveTab('operations')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${
            activeTab === 'operations'
              ? 'bg-raised text-signal shadow-sm border border-edge'
              : 'text-muted hover:text-body hover:bg-raised/40'
          }`}
        >
          <Terminal className="h-4 w-4" /> Host Server Ops
        </button>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          TAB 1: PLATFORM OVERVIEW & METRICS
      ───────────────────────────────────────────────────────────── */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Top Metric Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-edge bg-panel p-5 space-y-2">
              <div className="flex items-center justify-between text-muted text-xs">
                <span>Total Users</span>
                <Users className="h-4 w-4 text-signal" />
              </div>
              <div className="text-2xl font-bold font-mono text-body">
                {overview.data?.users.total ?? 0}
              </div>
              <div className="text-[11px] text-muted flex items-center gap-2">
                <span className="text-mint font-semibold">+{overview.data?.users.newLast7Days ?? 0}</span> new this week ·{' '}
                <span className="text-signal font-semibold">{overview.data?.users.admins ?? 0}</span> admins
              </div>
            </div>

            <div className="rounded-xl border border-edge bg-panel p-5 space-y-2">
              <div className="flex items-center justify-between text-muted text-xs">
                <span>Total Projects</span>
                <Database className="h-4 w-4 text-mint" />
              </div>
              <div className="text-2xl font-bold font-mono text-body">
                {overview.data?.projects.total ?? 0}
              </div>
              <div className="text-[11px] text-muted flex items-center gap-2">
                <span className="text-mint font-semibold">{overview.data?.projects.active ?? 0} active</span> ·{' '}
                <span className="text-coral font-semibold">{overview.data?.projects.failed ?? 0} failed</span>
              </div>
            </div>

            <div className="rounded-xl border border-edge bg-panel p-5 space-y-2">
              <div className="flex items-center justify-between text-muted text-xs">
                <span>Database Storage</span>
                <HardDrive className="h-4 w-4 text-signal" />
              </div>
              <div className="text-2xl font-bold font-mono text-body">
                {formatBytes(overview.data?.usage.databaseBytes ?? 0)}
              </div>
              <div className="text-[11px] text-muted">PostgreSQL 17 user tables & WAL</div>
            </div>

            <div className="rounded-xl border border-edge bg-panel p-5 space-y-2">
              <div className="flex items-center justify-between text-muted text-xs">
                <span>Object Storage</span>
                <Layers className="h-4 w-4 text-amber" />
              </div>
              <div className="text-2xl font-bold font-mono text-body">
                {formatBytes(overview.data?.usage.storageBytes ?? 0)}
              </div>
              <div className="text-[11px] text-muted">MinIO S3 Buckets across projects</div>
            </div>
          </div>

          {/* Connection Pool Health */}
          <div className="rounded-xl border border-edge bg-panel p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-edge pb-3">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-signal" />
                <h3 className="font-semibold text-body text-sm">PostgreSQL Multi-Tenant Connection Pool</h3>
              </div>
              <span className="rounded bg-mint/15 px-2 py-0.5 text-[11px] font-mono text-mint border border-mint/30">
                Pool Manager Active
              </span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 font-mono text-xs">
              <div className="rounded-lg border border-edge bg-raised/40 p-3">
                <span className="text-muted block text-[10px] uppercase">Active Project Pools</span>
                <span className="text-lg font-bold text-body">{overview.data?.connections.pools ?? 0}</span>
              </div>
              <div className="rounded-lg border border-edge bg-raised/40 p-3">
                <span className="text-muted block text-[10px] uppercase">Total Clients</span>
                <span className="text-lg font-bold text-signal">{overview.data?.connections.totalClients ?? 0}</span>
              </div>
              <div className="rounded-lg border border-edge bg-raised/40 p-3">
                <span className="text-muted block text-[10px] uppercase">Idle Clients</span>
                <span className="text-lg font-bold text-mint">{overview.data?.connections.idleClients ?? 0}</span>
              </div>
              <div className="rounded-lg border border-edge bg-raised/40 p-3">
                <span className="text-muted block text-[10px] uppercase">Waiting Queries</span>
                <span className="text-lg font-bold text-body">{overview.data?.connections.waitingQueries ?? 0}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          TAB 2: USERS & OPERATORS
      ───────────────────────────────────────────────────────────── */}
      {activeTab === 'users' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
              <input
                type="text"
                placeholder="Search users by email or name..."
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                className="h-9 w-full rounded-lg border border-edge bg-raised/50 pl-9 pr-3 text-xs text-body placeholder:text-muted focus:border-signal focus:outline-none font-mono"
              />
            </div>
            <span className="text-xs text-muted font-mono">{users.data?.length ?? 0} users found</span>
          </div>

          <div className="rounded-xl border border-edge bg-panel overflow-hidden">
            <table className="w-full border-collapse text-left text-xs font-mono">
              <thead className="bg-raised border-b border-edge text-[10px] text-muted uppercase">
                <tr>
                  <th className="px-4 py-2.5">User / Email</th>
                  <th className="px-3 py-2.5">Platform Role</th>
                  <th className="px-3 py-2.5">Security / MFA</th>
                  <th className="px-3 py-2.5">Orgs</th>
                  <th className="px-3 py-2.5">Last Session</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge/40">
                {users.isLoading ? (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-muted">
                      Loading user accounts…
                    </td>
                  </tr>
                ) : users.data?.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-muted">
                      No users match your search query.
                    </td>
                  </tr>
                ) : (
                  users.data?.map((user) => (
                    <tr key={user.id} className="hover:bg-raised/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-body">{user.email}</div>
                        {user.full_name ? <div className="text-[11px] text-muted">{user.full_name}</div> : null}
                      </td>
                      <td className="px-3 py-3">
                        {user.is_platform_admin ? (
                          <span className="inline-flex items-center gap-1 rounded bg-signal/20 px-2 py-0.5 text-[10px] font-bold text-signal border border-signal/30">
                            <ShieldCheck className="h-3 w-3" /> PLATFORM ADMIN
                          </span>
                        ) : (
                          <span className="rounded bg-raised px-2 py-0.5 text-[10px] text-muted">User</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {user.mfa_enabled ? (
                          <span className="inline-flex items-center gap-1 text-mint text-[11px]">
                            <Lock className="h-3 w-3" /> MFA Active
                          </span>
                        ) : (
                          <span className="text-muted text-[11px]">Disabled</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-body">{user.organizations}</td>
                      <td className="px-3 py-3 text-muted text-[11px]">
                        {user.last_session_at ? new Date(user.last_session_at).toLocaleString() : 'Never'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAdminToggleUser(user)}
                          className="h-7 text-[11px] border border-edge hover:bg-raised"
                        >
                          {user.is_platform_admin ? 'Revoke Admin' : 'Grant Admin'}
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          TAB 3: ALL PROJECTS
      ───────────────────────────────────────────────────────────── */}
      {activeTab === 'projects' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-edge bg-panel overflow-hidden">
            <table className="w-full border-collapse text-left text-xs font-mono">
              <thead className="bg-raised border-b border-edge text-[10px] text-muted uppercase">
                <tr>
                  <th className="px-4 py-2.5">Project Name / Ref</th>
                  <th className="px-3 py-2.5">Organization</th>
                  <th className="px-3 py-2.5">Owner</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Database</th>
                  <th className="px-3 py-2.5">Storage</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge/40">
                {projects.isLoading ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-muted">
                      Loading platform projects…
                    </td>
                  </tr>
                ) : projects.data?.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-muted">
                      No projects found.
                    </td>
                  </tr>
                ) : (
                  projects.data?.map((proj) => (
                    <tr key={proj.id} className="hover:bg-raised/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-body">{proj.name}</div>
                        <div className="text-[10px] text-signal">{proj.ref}</div>
                      </td>
                      <td className="px-3 py-3 text-muted">{proj.organization}</td>
                      <td className="px-3 py-3 text-muted">{proj.owner_email}</td>
                      <td className="px-3 py-3">
                        <span className="flex items-center gap-1.5 capitalize">
                          <StatusDot status={proj.status} />
                          <span>{proj.status}</span>
                        </span>
                      </td>
                      <td className="px-3 py-3 text-body font-semibold">
                        {formatBytes(Number(proj.database_bytes ?? 0))}
                      </td>
                      <td className="px-3 py-3 text-muted">
                        {formatBytes(Number(proj.storage_bytes ?? 0))}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Link
                            href={`/project/${proj.ref}`}
                            className="rounded px-2 py-1 bg-raised hover:bg-edge text-signal text-[11px] transition-colors"
                          >
                            Open
                          </Link>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => setSuspendProject(proj)}
                            className="h-6 text-[10px] border border-coral/30"
                          >
                            Suspend
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          TAB 4: SECURITY & AUDIT LOGS
      ───────────────────────────────────────────────────────────── */}
      {activeTab === 'security' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">
              Security events and quota guardrail records logged across the platform.
            </span>
            <div className="flex items-center gap-1 text-xs">
              <span className="text-muted">Window:</span>
              <select
                value={securityHours}
                onChange={(e) => setSecurityHours(Number(e.target.value))}
                className="rounded border border-edge bg-raised px-2 py-1 text-xs text-body"
              >
                <option value={24}>Last 24 Hours</option>
                <option value={168}>Last 7 Days</option>
                <option value={720}>Last 30 Days</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Top Audit Actions */}
            <div className="rounded-xl border border-edge bg-panel p-5 space-y-3">
              <div className="flex items-center justify-between border-b border-edge pb-2">
                <h3 className="font-semibold text-body text-xs uppercase tracking-wider">Top Audit Actions</h3>
                <span className="text-[10px] text-muted">Most frequent operations</span>
              </div>
              <div className="space-y-2 font-mono text-xs">
                {security.data?.topActions.map((act) => (
                  <div
                    key={act.action}
                    className="flex items-center justify-between p-2 rounded bg-raised/40 border border-edge/60"
                  >
                    <span className="font-semibold text-body">{act.action}</span>
                    <span className="rounded bg-signal/20 px-2 py-0.5 text-signal font-bold">{act.count}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Quota Violations */}
            <div className="rounded-xl border border-edge bg-panel p-5 space-y-3">
              <div className="flex items-center justify-between border-b border-edge pb-2">
                <h3 className="font-semibold text-body text-xs uppercase tracking-wider text-amber">
                  Quota Violations
                </h3>
                <span className="text-[10px] text-muted">Blocked resource requests</span>
              </div>
              <div className="space-y-2 font-mono text-xs">
                {security.data?.quotaViolations.length === 0 ? (
                  <div className="p-4 text-center text-muted">No quota violations in this window.</div>
                ) : (
                  security.data?.quotaViolations.map((v, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between p-2 rounded bg-amber/10 border border-amber/30 text-amber"
                    >
                      <span>
                        {v.resource} on <strong>{v.project_ref}</strong>
                      </span>
                      <span className="font-bold">{v.count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          TAB 5: HOST SERVER OPERATIONS
      ───────────────────────────────────────────────────────────── */}
      {activeTab === 'operations' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-edge bg-panel p-6 space-y-4">
            <div className="flex items-center gap-2 border-b border-edge pb-3">
              <Server className="h-5 w-5 text-signal" />
              <div>
                <h3 className="font-semibold text-body text-sm">Remote Laptop Host Services</h3>
                <p className="text-xs text-muted">Hardware, service daemons, and system-level operations</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg border border-edge bg-raised/30 p-4 space-y-2">
                <span className="font-semibold text-body text-xs block">Database Engine Maintenance</span>
                <p className="text-xs text-muted">
                  Perform full vacuuming and query plan statistics updates on the server host.
                </p>
                <div className="pt-2">
                  <Link
                    href="/admin/server"
                    className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 bg-signal text-white text-xs font-semibold hover:bg-signal/90"
                  >
                    Open Server Console <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </div>

              <div className="rounded-lg border border-edge bg-raised/30 p-4 space-y-2">
                <span className="font-semibold text-body text-xs block">Firewall & Network Perimeter</span>
                <p className="text-xs text-muted">
                  Inspect NFTables rulesets, rate limits, and exposed network sockets on Laptop A.
                </p>
                <div className="pt-2">
                  <Link
                    href="/admin/server/firewall"
                    className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 bg-raised text-body text-xs font-semibold hover:bg-edge border border-edge"
                  >
                    View Host Firewall <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          MODAL: GRANT / REVOKE PLATFORM ADMIN
      ───────────────────────────────────────────────────────────── */}
      {adminToggleUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-edge bg-panel p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-edge pb-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-signal" />
                <h3 className="font-semibold text-body text-sm">
                  {adminToggleUser.is_platform_admin ? 'Revoke Platform Admin' : 'Grant Platform Admin'}
                </h3>
              </div>
              <button onClick={() => setAdminToggleUser(null)} className="text-muted hover:text-body">
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-xs text-muted">
              {adminToggleUser.is_platform_admin
                ? `Revoking operator privileges from ${adminToggleUser.email} will prevent access to tenant data and global platform administration.`
                : `Granting platform operator privileges to ${adminToggleUser.email} gives full administrative control over all organizations, projects, and users.`}
            </p>

            <div>
              <label className="text-[11px] text-muted block mb-1">Reason for Audit Log:</label>
              <Input
                value={adminToggleReason}
                onChange={(e) => setAdminToggleReason(e.target.value)}
                placeholder="e.g. Lead database administrator onboarding"
                className="text-xs"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-edge">
              <Button size="sm" variant="ghost" onClick={() => setAdminToggleUser(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant={adminToggleUser.is_platform_admin ? 'danger' : 'primary'}
                onClick={() => {
                  toggleAdminMutation.mutate({
                    userId: adminToggleUser.id,
                    isAdmin: !adminToggleUser.is_platform_admin,
                    reason: adminToggleReason,
                  });
                }}
              >
                {adminToggleUser.is_platform_admin ? 'Revoke Access' : 'Grant Admin Privileges'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          MODAL: SUSPEND PROJECT CONFIRMATION
      ───────────────────────────────────────────────────────────── */}
      {suspendProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-coral/50 bg-panel p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-2 text-coral">
              <AlertTriangle className="h-5 w-5" />
              <h3 className="font-semibold text-body text-sm">Suspend Project Confirmation</h3>
            </div>

            <p className="text-xs text-muted">
              Suspending <strong className="text-body">{suspendProject.name}</strong> will set all resource quotas to zero, evict connection pools, and block all database queries immediately.
            </p>

            <div className="space-y-2">
              <div>
                <label className="text-[11px] text-muted block mb-1">
                  Type <strong className="text-coral font-mono">{suspendProject.ref}</strong> to confirm:
                </label>
                <Input
                  value={suspendConfirmText}
                  onChange={(e) => setSuspendConfirmText(e.target.value)}
                  placeholder={suspendProject.ref}
                  className="font-mono text-xs"
                />
              </div>

              <div>
                <label className="text-[11px] text-muted block mb-1">Reason for suspension:</label>
                <Input
                  value={suspendReason}
                  onChange={(e) => setSuspendReason(e.target.value)}
                  placeholder="e.g. Terms of service violation, billing hold"
                  className="text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-edge">
              <Button size="sm" variant="ghost" onClick={() => setSuspendProject(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={suspendConfirmText !== suspendProject.ref || !suspendReason.trim()}
                onClick={() => {
                  suspendProjectMutation.mutate({
                    ref: suspendProject.ref,
                    confirm: suspendConfirmText,
                    reason: suspendReason,
                  });
                }}
              >
                Suspend Project
              </Button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
