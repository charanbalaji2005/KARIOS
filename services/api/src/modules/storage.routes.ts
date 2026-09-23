import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { storage, verifySignedToken } from '../lib/storage/index.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { many, one, query } from '../db/platform.js';
import { ApiError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { consume, RULES } from '../lib/rate-limit.js';
import { enforceSampledQuota, getQuotas } from '../lib/quotas.js';
import { publishEvent } from './events.js';

/**
 * Routes never touch a storage SDK directly — everything goes through the
 * configured driver, so `STORAGE_DRIVER=local` (the laptop's disk) and
 * `STORAGE_DRIVER=s3` (MinIO / S3 / R2) are the same code path.
 */

/**
 * Object paths are attacker-controlled, so they are normalised hard: no
 * traversal segments, no leading slash, no control characters, bounded depth.
 */
export function safePath(input: string): string {
  const cleaned = input.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!cleaned) throw new ApiError('VALIDATION_ERROR', 'A file path is required');
  if (cleaned.length > 1024) throw new ApiError('VALIDATION_ERROR', 'That path is too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(cleaned)) throw new ApiError('VALIDATION_ERROR', 'That path contains invalid characters');

  const segments = cleaned.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) {
    throw new ApiError('VALIDATION_ERROR', 'Paths cannot contain . or .. segments');
  }
  if (segments.length > 20) throw new ApiError('VALIDATION_ERROR', 'That path is nested too deeply');
  return segments.join('/');
}


export default async function storageRoutes(app: FastifyInstance) {
  const read = { preHandler: [app.requireProject('storage.read')] };
  const write = { preHandler: [app.requireProject('storage.write')] };
  const adminOnly = { preHandler: [app.requireProject('storage.admin')] };

  app.get('/projects/:projectId/storage/buckets', read, async (req) => {
    const buckets = await many(
      `SELECT b.id, b.name, b.public, b.file_size_limit, b.allowed_mime_types, b.created_at,
              (SELECT COUNT(*) FROM storage_objects o WHERE o.bucket_id = b.id) AS object_count,
              (SELECT COALESCE(SUM(o.size), 0) FROM storage_objects o WHERE o.bucket_id = b.id) AS total_bytes
         FROM storage_buckets b WHERE b.project_id = $1 ORDER BY b.created_at`,
      [req.project!.id],
    );
    return { data: buckets, error: null };
  });

  app.post('/projects/:projectId/storage/buckets', write, async (req, reply) => {
    const body = z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9-_]{1,62}$/, 'Use lowercase letters, numbers, dashes and underscores'),
      public: z.boolean().default(false),
      fileSizeLimit: z.number().int().positive().max(5 * 1024 * 1024 * 1024).optional(),
      allowedMimeTypes: z.array(z.string().max(120)).max(50).optional(),
    }).parse(req.body);

    await storage.ensureNamespace(req.project!.ref);
    const existing = await one('SELECT id FROM storage_buckets WHERE project_id = $1 AND name = $2', [req.project!.id, body.name]);
    if (existing) throw new ApiError('CONFLICT', `A bucket named "${body.name}" already exists`);

    const bucket = await one(
      `INSERT INTO storage_buckets (project_id, name, public, file_size_limit, allowed_mime_types)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, public, created_at`,
      [req.project!.id, body.name, body.public, body.fileSizeLimit ?? null, body.allowedMimeTypes ?? null],
    );

    void audit(req, { action: 'BUCKET_CREATED', projectId: req.project!.id, resourceType: 'bucket', resourceId: body.name });
    return reply.code(201).send({ data: bucket, error: null });
  });

  app.delete('/projects/:projectId/storage/buckets/:bucket', adminOnly, async (req) => {
    const { bucket } = z.object({ bucket: z.string().min(1) }).parse(req.params);
    const body = z.object({ confirm: z.string() }).parse(req.body ?? {});
    if (body.confirm !== bucket) throw new ApiError('VALIDATION_ERROR', `Type "${bucket}" to confirm. Everything in it will be deleted.`);

    const row = await one<{ id: string }>('SELECT id FROM storage_buckets WHERE project_id = $1 AND name = $2', [req.project!.id, bucket]);
    if (!row) throw new ApiError('NOT_FOUND', 'Bucket not found');

    const objects = await many<{ path: string }>('SELECT path FROM storage_objects WHERE bucket_id = $1', [row.id]);
    for (const obj of objects) {
      await storage.remove(req.project!.ref, `${bucket}/${obj.path}`);
    }
    await query('DELETE FROM storage_buckets WHERE id = $1', [row.id]);

    void audit(req, { action: 'BUCKET_DELETED', projectId: req.project!.id, resourceType: 'bucket', resourceId: bucket });
    return { data: { deleted: true, objectsRemoved: objects.length }, error: null };
  });

  app.get('/projects/:projectId/storage/buckets/:bucket/objects', read, async (req) => {
    const { bucket } = z.object({ bucket: z.string().min(1) }).parse(req.params);
    const q = z.object({ prefix: z.string().max(1024).optional(), limit: z.coerce.number().min(1).max(500).default(100) }).parse(req.query);

    const row = await one<{ id: string }>('SELECT id FROM storage_buckets WHERE project_id = $1 AND name = $2', [req.project!.id, bucket]);
    if (!row) throw new ApiError('NOT_FOUND', 'Bucket not found');

    const objects = await many(
      `SELECT id, path, size, mime_type, metadata, created_at, updated_at
         FROM storage_objects
        WHERE bucket_id = $1 AND ($2::text IS NULL OR path LIKE $2 || '%')
        ORDER BY path LIMIT $3`,
      [row.id, q.prefix ?? null, q.limit],
    );
    return { data: objects, error: null };
  });

  /**
   * Uploads stream straight through to object storage — the file is never
   * buffered whole in memory, so a 2 GB upload costs a few MB of RAM.
   */
  app.post('/projects/:projectId/storage/buckets/:bucket/upload', write, async (req, reply) => {
    await consume('upload', req.project!.id, RULES.upload);
    const { bucket } = z.object({ bucket: z.string().min(1) }).parse(req.params);

    const bucketRow = await one<{ id: string; file_size_limit: string | null; allowed_mime_types: string[] | null }>(
      'SELECT id, file_size_limit, allowed_mime_types FROM storage_buckets WHERE project_id = $1 AND name = $2',
      [req.project!.id, bucket],
    );
    if (!bucketRow) throw new ApiError('NOT_FOUND', 'Bucket not found');

    // Two ceilings apply and the smaller wins: the bucket's own limit, set by
    // the project, and the project's quota, set by the operator. A project
    // cannot raise its own bucket limit past the quota it was given.
    const projectQuotas = await getQuotas(req.project!.id);
    const quotaFileLimit = projectQuotas.max_file_bytes === null ? Infinity : Number(projectQuotas.max_file_bytes);
    const bucketLimit = Number(bucketRow.file_size_limit ?? env.MAX_UPLOAD_BYTES);
    const effectiveLimit = Math.min(bucketLimit, quotaFileLimit);

    const file = await req.file({ limits: { fileSize: effectiveLimit } });
    if (!file) throw new ApiError('VALIDATION_ERROR', 'Attach a file to upload');

    const targetPath = safePath((file.fields?.['path'] as { value?: string } | undefined)?.value ?? file.filename);
    const mime = file.mimetype || 'application/octet-stream';
    if (bucketRow.allowed_mime_types?.length && !bucketRow.allowed_mime_types.includes(mime)) {
      throw new ApiError('VALIDATION_ERROR', `This bucket does not accept ${mime} files`);
    }

    // Checked before the write, against the last sampled figure. The project
    // can overshoot by whatever it uploads between two samples — see the note
    // in lib/quotas.ts. The alternative is recounting every object on every
    // upload, which does not scale past a few projects.
    await enforceSampledQuota(req.project!.id, 'storage_bytes', effectiveLimit === Infinity ? 0 : effectiveLimit);

    await storage.ensureNamespace(req.project!.ref);
    const key = `${bucket}/${targetPath}`;
    const { size: bytes } = await storage.put(req.project!.ref, key, file.file, mime);

    // Fastify's multipart limit truncates rather than throwing, so a file over
    // the bucket's ceiling arrives silently short. Deleting what landed is the
    // difference between rejecting an upload and storing a corrupt one.
    if (file.file.truncated) {
      await storage.remove(req.project!.ref, key);
      throw new ApiError('VALIDATION_ERROR', 'That file is larger than this bucket allows');
    }

    const object = await one(
      `INSERT INTO storage_objects (bucket_id, path, size, mime_type, uploaded_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (bucket_id, path) DO UPDATE
         SET size = EXCLUDED.size, mime_type = EXCLUDED.mime_type, updated_at = NOW()
       RETURNING id, path, size, mime_type, created_at`,
      [bucketRow.id, targetPath, bytes, mime, req.user!.id],
    );

    void publishEvent(req.project!.id, 'storage.upload', { bucket, path: targetPath, size: bytes });
    void audit(req, { action: 'STORAGE_OBJECT_UPLOADED', projectId: req.project!.id, resourceType: 'object', resourceId: `${bucket}/${targetPath}` });
    return reply.code(201).send({ data: object, error: null });
  });

  app.get('/projects/:projectId/storage/buckets/:bucket/download', read, async (req, reply) => {
    const { bucket } = z.object({ bucket: z.string().min(1) }).parse(req.params);
    const { path } = z.object({ path: z.string().min(1) }).parse(req.query);
    const key = `${bucket}/${safePath(path)}`;

    const object = await storage.get(req.project!.ref, key);
    reply.header('content-type', object.contentType);
    if (object.contentLength) reply.header('content-length', String(object.contentLength));
    return reply.send(object.stream);
  });

  app.post('/projects/:projectId/storage/buckets/:bucket/signed-url', read, async (req) => {
    const { bucket } = z.object({ bucket: z.string().min(1) }).parse(req.params);
    const body = z.object({
      path: z.string().min(1),
      expiresIn: z.number().int().min(30).max(7 * 24 * 3600).default(3600),
      action: z.enum(['download', 'upload']).default('download'),
    }).parse(req.body);

    const key = `${bucket}/${safePath(body.path)}`;
    const url = await storage.signedUrl(req.project!.ref, key, {
      expiresIn: body.expiresIn,
      action: body.action,
    });
    return { data: { url, expiresIn: body.expiresIn, expiresAt: new Date(Date.now() + body.expiresIn * 1000) }, error: null };
  });

  app.delete('/projects/:projectId/storage/buckets/:bucket/objects', write, async (req) => {
    const { bucket } = z.object({ bucket: z.string().min(1) }).parse(req.params);
    const body = z.object({ path: z.string().min(1) }).parse(req.body);
    const path = safePath(body.path);

    const row = await one<{ id: string }>('SELECT id FROM storage_buckets WHERE project_id = $1 AND name = $2', [req.project!.id, bucket]);
    if (!row) throw new ApiError('NOT_FOUND', 'Bucket not found');

    await storage.remove(req.project!.ref, `${bucket}/${path}`);
    await query('DELETE FROM storage_objects WHERE bucket_id = $1 AND path = $2', [row.id, path]);

    void publishEvent(req.project!.id, 'storage.delete', { bucket, path });
    void audit(req, { action: 'STORAGE_OBJECT_DELETED', projectId: req.project!.id, resourceType: 'object', resourceId: `${bucket}/${path}` });
    return { data: { deleted: true }, error: null };
  });

  /** Public read path for buckets marked public — no session, no API key. */
  app.get('/storage/v1/public/:ref/:bucket/*', async (req, reply) => {
    const params = req.params as { ref: string; bucket: string; '*': string };
    const project = await one<{ id: string; ref: string }>('SELECT id, ref FROM projects WHERE ref = $1 AND deleted_at IS NULL', [params.ref]);
    if (!project) throw new ApiError('NOT_FOUND', 'Project not found');

    const bucketRow = await one<{ public: boolean }>(
      'SELECT public FROM storage_buckets WHERE project_id = $1 AND name = $2',
      [project.id, params.bucket],
    );
    if (!bucketRow?.public) throw new ApiError('NOT_FOUND', 'File not found');

    const key = `${params.bucket}/${safePath(params['*'])}`;
    const object = await storage.get(project.ref, key);
    reply.header('content-type', object.contentType);
    reply.header('cache-control', 'public, max-age=3600');
    return reply.send(object.stream);
  });

  /**
   * Signed-URL endpoint for the local driver.
   *
   * S3 verifies its own presigned URLs at the storage endpoint; a filesystem
   * has nobody to do that, so the API does it here. The token is an HMAC over
   * ref, key, action and expiry — no server-side state, no lookup.
   *
   * Deliberately unauthenticated: possession of a valid, unexpired token IS
   * the authorisation. That is the entire point of a signed URL.
   */
  app.get('/storage/v1/signed/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(16).max(2048) }).parse(req.params);
    const payload = verifySignedToken(token);
    // One message for expired, forged and malformed alike. Telling a caller
    // which of the three it was hands them a free oracle.
    if (!payload || payload.act !== 'download') {
      throw new ApiError('NOT_FOUND', 'This link is invalid or has expired');
    }

    const object = await storage.get(payload.ref, payload.key);
    reply.header('content-type', object.contentType);
    if (object.contentLength) reply.header('content-length', String(object.contentLength));
    reply.header('cache-control', 'private, no-store');
    return reply.send(object.stream);
  });
}
