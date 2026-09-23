'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, formatBytes } from '@/lib/api';
import { Alert, Button, Empty, Field, Input, Panel, Skeleton, StatusDot } from '@/components/ui';

interface Project {
  id: string; ref: string; name: string; status: string; region: string; created_at: string;
}
interface Organization { id: string; name: string; role: string; project_count: string }

export default function ProjectsPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [keys, setKeys] = useState<{ ref: string; anon: string; serviceRole: string } | null>(null);

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/v1/projects') });
  const orgs = useQuery({ queryKey: ['organizations'], queryFn: () => api<Organization[]>('/api/v1/organizations') });

  const create = useMutation({
    mutationFn: (payload: { name: string; organizationId: string }) =>
      api<{ ref: string; keys: { anon: string; serviceRole: string } }>('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      setKeys({ ref: data.ref, anon: data.keys.anon, serviceRole: data.keys.serviceRole });
      setCreating(false);
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="mb-8 flex items-end justify-between">
        <div>
          <p className="font-mono text-xs tracking-wide text-signal">kairosdb</p>
          <h1 className="mt-2 text-xl font-semibold text-body">Projects</h1>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/admin" className="font-mono text-xs text-signal hover:text-signal/80 flex items-center gap-1 font-semibold">
            Admin panel
          </Link>
          <Link href="/server" className="font-mono text-xs text-muted hover:text-body">
            Server health
          </Link>
          <Button variant="primary" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Cancel' : 'New project'}
          </Button>
        </div>
      </div>

      {keys ? (
        <div className="mb-6 rounded-lg border border-[#3B3468] bg-[#1B1830] p-4">
          <p className="text-sm font-medium text-body">Save these keys now</p>
          <p className="mt-1 text-sm text-muted">
            They are shown once. The service role key bypasses row level security, so keep it on your server.
          </p>
          <dl className="mt-3 space-y-2 font-mono text-xs">
            <div><dt className="text-muted">anon</dt><dd className="break-all text-body">{keys.anon}</dd></div>
            <div><dt className="text-muted">service_role</dt><dd className="break-all text-body">{keys.serviceRole}</dd></div>
          </dl>
          <Button size="sm" className="mt-3" onClick={() => setKeys(null)}>I saved them</Button>
        </div>
      ) : null}

      {creating ? (
        <div className="mb-6">
          <Panel title="Create a project">
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                const organizationId = orgs.data?.[0]?.id;
                if (organizationId) create.mutate({ name, organizationId });
              }}
            >
              <Field label="Project name" hint="Provisioning creates a dedicated Postgres database and API keys.">
                <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Recipe app" />
              </Field>
              {create.isError ? <Alert>{(create.error as Error).message}</Alert> : null}
              <Button type="submit" variant="primary" disabled={create.isPending}>
                {create.isPending ? 'Provisioning…' : 'Create project'}
              </Button>
            </form>
          </Panel>
        </div>
      ) : null}

      {projects.isLoading ? (
        <Skeleton rows={4} />
      ) : projects.data?.length ? (
        <ul className="divide-y divide-edge overflow-hidden rounded-lg border border-edge bg-panel">
          {projects.data.map((project) => (
            <li key={project.id}>
              <Link
                href={`/project/${project.ref}`}
                className="flex items-center justify-between px-4 py-3.5 hover:bg-raised"
              >
                <div>
                  <p className="text-sm font-medium text-body">{project.name}</p>
                  <p className="mt-0.5 font-mono text-xs text-muted">{project.ref}</p>
                </div>
                <span className="flex items-center gap-2 text-xs text-muted">
                  <StatusDot status={project.status} />
                  {project.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty
          title="No projects yet"
          description="Create your first project to get a Postgres database, a REST API and keys."
          action={<Button variant="primary" onClick={() => setCreating(true)}>Create project</Button>}
        />
      )}
    </main>
  );
}
