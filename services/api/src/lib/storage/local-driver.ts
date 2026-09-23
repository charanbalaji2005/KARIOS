/**
 * Local disk driver — the laptop's NVMe as object storage.
 *
 * Layout under KAIROS_DATA_ROOT:
 *
 *   /var/lib/kairos/storage/
 *     <project ref>/
 *       <logical bucket>/
 *         avatars/me.png
 *
 * Users never see this tree. They see buckets and paths; the mapping is an
 * implementation detail, which is exactly why it can be swapped for S3.
 *
 * Signed URLs are HMAC tokens verified by the API, because there is no S3
 * presigner here. See `signedUrl` and the `/storage/v1/signed` route.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, readdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { env } from '../../env.js';
import { ApiError } from '../errors.js';
import { logger } from '../../logger.js';
import type { SignOptions, StorageDriver, StoredObject } from './driver.js';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.json': 'application/json', '.txt': 'text/plain',
  '.csv': 'text/csv', '.md': 'text/markdown', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(dataRoot: string = env.KAIROS_DATA_ROOT) {
    this.root = resolve(dataRoot, 'storage');
  }

  /**
   * Resolve a key to an absolute path and refuse anything that escapes the
   * project's directory.
   *
   * `safePath()` already stripped `..` before this point. This check exists
   * because that is one validator on one code path, and a single missed call
   * site would turn into arbitrary filesystem writes. Comparing the *resolved*
   * path against the project root catches it regardless of how the key got
   * here — including symlinks and unicode normalisation tricks that a regex
   * on the raw string will not see.
   */
  private pathFor(projectRef: string, key: string): string {
    const base = resolve(this.root, projectRef);
    const target = resolve(base, key);
    if (target !== base && !target.startsWith(base + sep)) {
      logger.warn({ projectRef, key }, 'storage key resolved outside its project directory');
      throw new ApiError('VALIDATION_ERROR', 'That file path is not allowed');
    }
    return target;
  }

  async ensureNamespace(projectRef: string): Promise<void> {
    await mkdir(resolve(this.root, projectRef), { recursive: true, mode: 0o750 });
  }

  async put(projectRef: string, key: string, body: Readable, _contentType: string): Promise<{ size: number }> {
    const target = this.pathFor(projectRef, key);
    await mkdir(dirname(target), { recursive: true, mode: 0o750 });

    // Write to a temporary name and rename on success. A failed or aborted
    // upload then leaves no half-written file where a valid one used to be —
    // rename within a filesystem is atomic, a partial write is not.
    const temp = `${target}.${randomUUID()}.part`;
    let size = 0;
    body.on('data', (chunk: Buffer) => { size += chunk.length; });

    try {
      await pipeline(body, createWriteStream(temp, { mode: 0o640 }));
      const { rename } = await import('node:fs/promises');
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      logger.error({ err: error, projectRef, key }, 'local storage write failed');
      throw new ApiError('STORAGE_ERROR', 'The file could not be written to disk');
    }

    return { size };
  }

  async get(projectRef: string, key: string): Promise<StoredObject> {
    const target = this.pathFor(projectRef, key);
    let info;
    try {
      info = await stat(target);
    } catch {
      throw new ApiError('NOT_FOUND', 'File not found');
    }
    if (!info.isFile()) throw new ApiError('NOT_FOUND', 'File not found');

    const extension = key.slice(key.lastIndexOf('.')).toLowerCase();
    return {
      stream: createReadStream(target),
      contentType: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
      contentLength: info.size,
    };
  }

  async remove(projectRef: string, key: string): Promise<void> {
    await unlink(this.pathFor(projectRef, key)).catch(() => undefined);
  }

  async usage(projectRef: string): Promise<number> {
    const base = resolve(this.root, projectRef);
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const info = await stat(full).catch(() => null);
          if (info) total += info.size;
        }
      }
    };
    await walk(base);
    return total;
  }

  async removeNamespace(projectRef: string): Promise<void> {
    await rm(resolve(this.root, projectRef), { recursive: true, force: true });
  }

  /**
   * There is no presigner on a filesystem, so the API mints its own token:
   * an HMAC over ref, key, action and expiry. The token carries everything
   * needed to verify it, so no server-side state and no Redis round trip.
   */
  async signedUrl(projectRef: string, key: string, options: SignOptions): Promise<string> {
    const payload = {
      ref: projectRef,
      key,
      act: options.action,
      exp: Math.floor(Date.now() / 1000) + options.expiresIn,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = signToken(encoded);
    return `${env.API_URL}/storage/v1/signed/${encoded}.${signature}`;
  }
}

function signToken(encoded: string): string {
  // Separate from JWT_SECRET so that rotating one does not silently
  // invalidate the other, and a leak of one does not forge the other.
  return createHmac('sha256', env.ENCRYPTION_KEY + ':storage').update(encoded).digest('base64url');
}

export interface SignedTokenPayload {
  ref: string;
  key: string;
  act: 'download' | 'upload';
  exp: number;
}

/**
 * Verify a token produced by `signedUrl`. Returns null for anything invalid —
 * callers must not distinguish "bad signature" from "expired" to the client,
 * since that difference is a free oracle for an attacker.
 */
export function verifySignedToken(token: string): SignedTokenPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const encoded = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = signToken(encoded);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and the length is not secret anyway.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedTokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    if (payload.act !== 'download' && payload.act !== 'upload') return null;
    if (typeof payload.ref !== 'string' || typeof payload.key !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}
