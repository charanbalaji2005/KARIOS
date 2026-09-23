'use client';

/**
 * Storage browser.
 *
 * Buckets, files, upload, download, signed links, delete. Uploads go directly
 * to the API rather than through a Next.js route handler, so a large file
 * streams once instead of being buffered by an intermediate hop.
 */

import { use, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatBytes, session } from '@/lib/api';
import { Alert, Button, Empty, Field, Input, Panel, Skeleton } from '@/components/ui';
import {
  Eye, Download, ExternalLink, X, FileText,
  Image as ImageIcon, Music, Video, FileCode, File as FileIcon, Copy, Check
} from 'lucide-react';

interface Bucket {
  id: string; name: string; public: boolean;
  object_count: string; total_bytes: string; created_at: string;
}
interface StorageObject {
  id: string; path: string; size: string; mime_type: string; created_at: string;
}

export default function StoragePage({ params }: { params: Promise<{ ref: string }> | { ref: string } }) {
  const { ref } = params instanceof Promise ? use(params) : params;
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [active, setActive] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newBucket, setNewBucket] = useState({ name: '', public: false });
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewObject, setPreviewObject] = useState<StorageObject | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

  const buckets = useQuery({
    queryKey: ['buckets', ref],
    queryFn: () => api<Bucket[]>(`/api/v1/projects/${ref}/storage/buckets`),
  });

  const objects = useQuery({
    queryKey: ['objects', ref, active],
    queryFn: () => api<StorageObject[]>(`/api/v1/projects/${ref}/storage/buckets/${active}/objects`),
    enabled: Boolean(active),
  });

  const createBucket = useMutation({
    mutationFn: () =>
      api(`/api/v1/projects/${ref}/storage/buckets`, {
        method: 'POST',
        body: JSON.stringify(newBucket),
      }),
    onSuccess: () => {
      setCreating(false);
      setNewBucket({ name: '', public: false });
      void queryClient.invalidateQueries({ queryKey: ['buckets', ref] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const removeObject = useMutation({
    mutationFn: (path: string) =>
      api(`/api/v1/projects/${ref}/storage/buckets/${active}/objects`, {
        method: 'DELETE',
        body: JSON.stringify({ path }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['objects', ref, active] }),
    onError: (err: Error) => setError(err.message),
  });

  /**
   * Upload straight to the API. FormData rather than JSON so the file streams;
   * base64 in a JSON body would inflate it by a third and hold the whole thing
   * in memory on both ends.
   */
  async function upload(file: File) {
    if (!active) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('path', file.name);
      form.append('file', file);

      const response = await fetch(`${apiBase}/api/v1/projects/${ref}/storage/buckets/${active}/upload`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.get()}` },
        body: form,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? 'Upload failed');
      void queryClient.invalidateQueries({ queryKey: ['objects', ref, active] });
      void queryClient.invalidateQueries({ queryKey: ['buckets', ref] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function sign(path: string) {
    setError(null);
    try {
      const result = await api<{ url: string; expiresIn: number }>(
        `/api/v1/projects/${ref}/storage/buckets/${active}/signed-url`,
        { method: 'POST', body: JSON.stringify({ path, expiresIn: 3600, action: 'download' }) },
      );
      setSignedUrl(result.url);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function getFileIcon(mime: string, path: string) {
    const p = path.toLowerCase();
    if (mime === 'application/pdf' || p.endsWith('.pdf')) {
      return <FileText className="h-4 w-4 text-red-400 shrink-0" />;
    }
    if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/.test(p)) {
      return <ImageIcon className="h-4 w-4 text-blue-400 shrink-0" />;
    }
    if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac)$/.test(p)) {
      return <Music className="h-4 w-4 text-purple-400 shrink-0" />;
    }
    if (mime.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/.test(p)) {
      return <Video className="h-4 w-4 text-amber-400 shrink-0" />;
    }
    if (
      mime.startsWith('text/') ||
      mime.includes('json') ||
      mime.includes('xml') ||
      mime.includes('csv') ||
      /\.(txt|json|csv|tsv|md|sql|js|ts|tsx|jsx|html|css|py|sh|yaml|yml|log|conf|env)$/.test(p)
    ) {
      return <FileCode className="h-4 w-4 text-emerald-400 shrink-0" />;
    }
    return <FileIcon className="h-4 w-4 text-muted shrink-0" />;
  }

  async function openPreview(obj: StorageObject) {
    setPreviewObject(obj);
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewUrl(null);
    setPreviewText(null);
    setCopied(false);

    try {
      const token = session.get();
      const res = await fetch(
        `${apiBase}/api/v1/projects/${ref}/storage/buckets/${active}/download?path=${encodeURIComponent(obj.path)}`,
        { headers: token ? { authorization: `Bearer ${token}` } : {} }
      );
      if (!res.ok) {
        throw new Error(`Failed to load file: HTTP ${res.status}`);
      }
      const mime = obj.mime_type || res.headers.get('content-type') || 'application/octet-stream';
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(new Blob([blob], { type: mime }));
      setPreviewUrl(objectUrl);

      const p = obj.path.toLowerCase();
      if (
        mime.startsWith('text/') ||
        mime.includes('json') ||
        mime.includes('xml') ||
        mime.includes('csv') ||
        /\.(txt|json|csv|tsv|md|sql|js|ts|tsx|jsx|html|css|py|sh|yaml|yml|log|conf|env)$/.test(p)
      ) {
        const text = await blob.text();
        setPreviewText(text);
      }
    } catch (err) {
      try {
        const result = await api<{ url: string }>(
          `/api/v1/projects/${ref}/storage/buckets/${active}/signed-url`,
          { method: 'POST', body: JSON.stringify({ path: obj.path, expiresIn: 3600, action: 'download' }) },
        );
        setPreviewUrl(result.url);
      } catch {
        setPreviewError((err as Error).message);
      }
    } finally {
      setPreviewLoading(false);
    }
  }

  function closePreview() {
    if (previewUrl && previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewObject(null);
    setPreviewUrl(null);
    setPreviewText(null);
    setPreviewError(null);
    setCopied(false);
  }

  function copyText() {
    if (!previewText) return;
    void navigator.clipboard.writeText(previewText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closePreview();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewUrl]);

  return (
    <main className="px-8 py-10">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-body">Storage</h1>
          <p className="mt-1 text-sm text-muted">Files live on this server&apos;s own disk unless you configured S3.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating((value) => !value)}>
          {creating ? 'Cancel' : 'New bucket'}
        </Button>
      </div>

      {error ? <div className="mt-4"><Alert>{error}</Alert></div> : null}

      {creating ? (
        <div className="mt-6">
          <Panel title="New bucket">
            <Field label="Name" hint="Lowercase letters, numbers, dashes and underscores.">
              <Input
                value={newBucket.name}
                onChange={(event) => setNewBucket((value) => ({ ...value, name: event.target.value }))}
                placeholder="avatars"
              />
            </Field>
            <label className="mt-4 flex items-center gap-2 text-sm text-body">
              <input
                type="checkbox"
                checked={newBucket.public}
                onChange={(event) => setNewBucket((value) => ({ ...value, public: event.target.checked }))}
              />
              Public — anyone with the URL can read these files
            </label>
            <div className="mt-4">
              <Button variant="primary" onClick={() => createBucket.mutate()} disabled={!newBucket.name}>
                Create
              </Button>
            </div>
          </Panel>
        </div>
      ) : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Panel title="Buckets">
          {buckets.isLoading ? (
            <Skeleton rows={3} />
          ) : buckets.data?.length === 0 ? (
            <p className="text-sm text-muted">No buckets yet.</p>
          ) : (
            <ul className="space-y-1">
              {buckets.data?.map((bucket) => (
                <li key={bucket.id}>
                  <button
                    onClick={() => { setActive(bucket.name); setSignedUrl(null); }}
                    className={`w-full rounded px-3 py-2 text-left ${
                      active === bucket.name ? 'bg-raised text-body' : 'text-muted hover:text-body'
                    }`}
                  >
                    <span className="font-mono text-sm">{bucket.name}</span>
                    {bucket.public ? <span className="ml-2 text-xs text-amber">public</span> : null}
                    <span className="mt-0.5 block font-mono text-xs text-muted">
                      {bucket.object_count} files · {formatBytes(Number(bucket.total_bytes))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title={active ? `${active} — files` : 'Files'}
          action={
            active ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(file);
                  }}
                />
                <Button onClick={() => fileInput.current?.click()} disabled={uploading}>
                  {uploading ? 'Uploading…' : 'Upload'}
                </Button>
              </>
            ) : undefined
          }
        >
          {!active ? (
            <Empty title="Pick a bucket" description="Choose one on the left to see what is in it." />
          ) : objects.isLoading ? (
            <Skeleton rows={4} />
          ) : objects.data?.length === 0 ? (
            <Empty title="Empty bucket" description="Upload a file to get started." />
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-edge text-xs uppercase tracking-wide text-muted">
                  <th className="py-2">Path</th>
                  <th className="py-2">Size</th>
                  <th className="py-2">Type</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {objects.data?.map((object) => (
                  <tr key={object.id} className="border-b border-edge/50 hover:bg-raised/30 transition-colors">
                    <td className="py-2.5 font-mono text-xs text-body">
                      <button
                        type="button"
                        onClick={() => void openPreview(object)}
                        className="group flex items-center gap-2 text-left hover:text-signal transition-colors"
                      >
                        {getFileIcon(object.mime_type, object.path)}
                        <span className="group-hover:underline">{object.path}</span>
                      </button>
                    </td>
                    <td className="py-2.5 font-mono text-xs text-muted">{formatBytes(Number(object.size))}</td>
                    <td className="py-2.5 font-mono text-xs text-muted">{object.mime_type}</td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      <button
                        onClick={() => void openPreview(object)}
                        className="mr-3 inline-flex items-center gap-1 text-xs text-signal hover:underline"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        preview
                      </button>
                      <button onClick={() => void sign(object.path)} className="mr-3 text-xs text-signal hover:underline">
                        link
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Delete ${object.path}? This cannot be undone.`)) removeObject.mutate(object.path);
                        }}
                        className="text-xs text-coral hover:underline"
                      >
                        delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {signedUrl ? (
            <div className="mt-4 rounded border border-edge bg-raised p-3">
              <p className="text-xs text-muted">Signed link, valid for one hour:</p>
              <code className="mt-1 block break-all font-mono text-xs text-body">{signedUrl}</code>
            </div>
          ) : null}
        </Panel>
      </div>

      {/* File Preview Modal */}
      {previewObject ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 sm:p-6 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) closePreview();
          }}
        >
          <div className="relative flex max-h-[92vh] w-full max-w-5xl flex-col rounded-xl border border-edge bg-panel shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-edge bg-raised/50 px-5 py-3.5">
              <div className="flex items-center gap-3 min-w-0 pr-4">
                <div className="rounded-lg border border-edge bg-panel p-2">
                  {getFileIcon(previewObject.mime_type, previewObject.path)}
                </div>
                <div className="min-w-0">
                  <h3 className="truncate font-mono text-sm font-semibold text-body">
                    {previewObject.path}
                  </h3>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                    <span>{formatBytes(Number(previewObject.size))}</span>
                    <span>•</span>
                    <span className="font-mono">{previewObject.mime_type}</span>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 shrink-0">
                {previewUrl ? (
                  <>
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded border border-edge bg-raised px-2.5 py-1.5 text-xs text-body hover:bg-raised/80 hover:text-white transition-colors"
                      title="Open in new tab"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      <span>Open</span>
                    </a>
                    <a
                      href={previewUrl}
                      download={previewObject.path.split('/').pop() ?? previewObject.path}
                      className="inline-flex items-center gap-1.5 rounded border border-edge bg-raised px-2.5 py-1.5 text-xs text-body hover:bg-raised/80 hover:text-white transition-colors"
                      title="Download file"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download</span>
                    </a>
                  </>
                ) : null}
                <button
                  onClick={() => void sign(previewObject.path)}
                  className="inline-flex items-center gap-1.5 rounded border border-edge bg-raised px-2.5 py-1.5 text-xs text-body hover:bg-raised/80 hover:text-white transition-colors"
                  title="Generate signed link"
                >
                  <span>Link</span>
                </button>
                <button
                  onClick={closePreview}
                  className="ml-1 rounded-md p-1.5 text-muted hover:bg-raised hover:text-body transition-colors"
                  title="Close (Esc)"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-auto p-4 sm:p-6 bg-[#0B0E14] min-h-[420px] flex flex-col justify-center">
              {previewLoading ? (
                <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-signal border-t-transparent" />
                  <p className="text-xs font-mono">Loading preview…</p>
                </div>
              ) : previewError ? (
                <div className="p-6 max-w-md mx-auto text-center">
                  <Alert>{previewError}</Alert>
                  <div className="mt-4 flex justify-center gap-2">
                    <Button size="sm" onClick={() => void openPreview(previewObject)}>Retry</Button>
                    {previewUrl ? (
                      <a
                        href={previewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded bg-signal px-3 py-1.5 text-xs text-white"
                      >
                        Open directly
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : (previewObject.mime_type === 'application/pdf' || previewObject.path.toLowerCase().endsWith('.pdf')) ? (
                <div className="flex flex-col h-[75vh] w-full">
                  <iframe
                    src={previewUrl ?? undefined}
                    className="h-full w-full rounded-lg border border-edge bg-white"
                    title={previewObject.path}
                  />
                </div>
              ) : (previewObject.mime_type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(previewObject.path)) ? (
                <div className="flex h-[75vh] w-full items-center justify-center overflow-auto rounded-lg border border-edge bg-[#080A0E] p-4">
                  <img
                    src={previewUrl ?? undefined}
                    alt={previewObject.path}
                    className="max-h-full max-w-full rounded object-contain shadow-xl"
                  />
                </div>
              ) : (previewObject.mime_type.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(previewObject.path)) ? (
                <div className="flex h-[70vh] w-full items-center justify-center rounded-lg border border-edge bg-black p-2">
                  <video controls src={previewUrl ?? undefined} className="max-h-full max-w-full rounded" />
                </div>
              ) : (previewObject.mime_type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac)$/i.test(previewObject.path)) ? (
                <div className="flex flex-col items-center justify-center gap-6 rounded-lg border border-edge bg-raised p-12">
                  <Music className="h-16 w-16 text-signal" />
                  <p className="font-mono text-sm text-body">{previewObject.path}</p>
                  <audio controls src={previewUrl ?? undefined} className="w-full max-w-md" />
                </div>
              ) : previewText !== null ? (
                <div className="relative flex flex-col max-h-[75vh] rounded-lg border border-edge bg-[#080A0E]">
                  <div className="flex items-center justify-between border-b border-edge/60 px-4 py-2 bg-raised/40">
                    <span className="text-xs text-muted font-mono">{previewText.split('\n').length} lines</span>
                    <button
                      onClick={copyText}
                      className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-muted hover:bg-raised hover:text-body transition-colors"
                    >
                      {copied ? <Check className="h-3.5 w-3.5 text-mint" /> : <Copy className="h-3.5 w-3.5" />}
                      <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <pre className="overflow-auto p-4 font-mono text-xs text-body leading-relaxed whitespace-pre">
                    {previewText}
                  </pre>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
                  <FileIcon className="h-14 w-14 text-muted" />
                  <div>
                    <p className="font-mono text-sm text-body">{previewObject.path}</p>
                    <p className="text-xs text-muted mt-1">Binary file ({previewObject.mime_type})</p>
                  </div>
                  {previewUrl ? (
                    <a
                      href={previewUrl}
                      download={previewObject.path.split('/').pop() ?? previewObject.path}
                      className="mt-2 inline-flex items-center gap-2 rounded bg-signal px-4 py-2 text-sm font-medium text-white hover:bg-[#6B58EF]"
                    >
                      <Download className="h-4 w-4" />
                      <span>Download file</span>
                    </a>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
