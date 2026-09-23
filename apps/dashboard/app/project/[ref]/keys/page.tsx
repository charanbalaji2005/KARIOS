'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { use, useState } from 'react';
import { api } from '@/lib/api';
import { Button, Empty, Panel, Skeleton } from '@/components/ui';

interface ApiKey {
  id: string; name: string; kind: string; prefix: string; last_used_at: string | null; revoked_at: string | null;
}

export default function KeysPage({ params }: { params: Promise<{ ref: string }> | { ref: string } }) {
  const { ref } = params instanceof Promise ? use(params) : params;
  const queryClient = useQueryClient();
  const [fresh, setFresh] = useState<string | null>(null);

  const keys = useQuery({ queryKey: ['keys', ref], queryFn: () => api<ApiKey[]>(`/api/v1/projects/${ref}/keys`) });

  const create = useMutation({
    mutationFn: () => api<{ key: string }>(`/api/v1/projects/${ref}/keys`, {
      method: 'POST',
      body: JSON.stringify({ name: `key-${Date.now().toString(36)}`, kind: 'secret' }),
    }),
    onSuccess: (data) => { setFresh(data.key); void queryClient.invalidateQueries({ queryKey: ['keys', ref] }); },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/v1/projects/${ref}/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['keys', ref] }),
  });

  return (
    <main className="px-8 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-body">API keys</h1>
        <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>Create key</Button>
      </div>

      {fresh ? (
        <div className="mb-6 rounded-lg border border-[#3B3468] bg-[#1B1830] p-4">
          <p className="text-sm text-body">Copy this key now — it is not shown again.</p>
          <code className="mt-2 block break-all font-mono text-xs text-body">{fresh}</code>
          <Button size="sm" className="mt-3" onClick={() => setFresh(null)}>Done</Button>
        </div>
      ) : null}

      <Panel>
        {keys.isLoading ? (
          <Skeleton rows={3} />
        ) : keys.data?.length ? (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th className="pb-2 font-normal">Name</th>
                <th className="pb-2 font-normal">Type</th>
                <th className="pb-2 font-normal">Prefix</th>
                <th className="pb-2 font-normal">Last used</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((key) => (
                <tr key={key.id} className="border-t border-edge">
                  <td className="py-2.5 text-body">{key.name}</td>
                  <td className="py-2.5 font-mono text-xs text-muted">{key.kind}</td>
                  <td className="py-2.5 font-mono text-xs text-muted">{key.prefix}…</td>
                  <td className="py-2.5 text-xs text-muted">
                    {key.last_used_at ? new Date(key.last_used_at).toLocaleString() : 'never'}
                  </td>
                  <td className="py-2.5 text-right">
                    {key.revoked_at ? (
                      <span className="text-xs text-muted">revoked</span>
                    ) : (
                      <Button size="sm" variant="danger" onClick={() => revoke.mutate(key.id)}>Revoke</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No keys yet" description="Create a key to call this project's REST API from your app." />
        )}
      </Panel>
    </main>
  );
}
