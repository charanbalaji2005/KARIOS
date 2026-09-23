/**
 * Storage driver interface.
 *
 * The laptop's own NVMe is the default backing store — that is the whole
 * premise of running your own cloud. But writing the routes directly against
 * `fs` would weld the platform to one machine forever, and writing them
 * directly against the S3 SDK (as they were) makes MinIO a hard dependency
 * for something as simple as saving a file to disk.
 *
 * So the routes talk to this interface and nothing else. Swapping
 * `STORAGE_DRIVER=local` for `STORAGE_DRIVER=s3` moves every project's files
 * from the laptop to MinIO, S3 or R2 without a line changing above this layer.
 * That is also the migration path off the laptop later.
 *
 * Keys are always `<logical bucket>/<object path>`, already normalised by
 * `safePath()`. Drivers must still treat them as hostile — see the resolved
 * path check in the local driver.
 */
import type { Readable } from 'node:stream';

export interface StoredObject {
  stream: Readable;
  contentType: string;
  contentLength?: number | undefined;
}

export interface SignOptions {
  expiresIn: number;
  action: 'download' | 'upload';
}

export interface StorageDriver {
  readonly name: 'local' | 's3';

  /** Create whatever the driver needs before a project's first write. */
  ensureNamespace(projectRef: string): Promise<void>;

  /** Stream `body` in. Returns the number of bytes actually written. */
  put(projectRef: string, key: string, body: Readable, contentType: string): Promise<{ size: number }>;

  get(projectRef: string, key: string): Promise<StoredObject>;

  /** Must not throw when the object is already gone. */
  remove(projectRef: string, key: string): Promise<void>;

  /** A time-limited URL the browser can use directly. */
  signedUrl(projectRef: string, key: string, options: SignOptions): Promise<string>;

  /** Storage consumed by one project, in bytes. Used for quota display. */
  usage(projectRef: string): Promise<number>;

  /** Remove everything belonging to a project. Called on deprovision. */
  removeNamespace(projectRef: string): Promise<void>;
}
