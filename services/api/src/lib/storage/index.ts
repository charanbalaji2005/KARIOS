/**
 * Driver selection. One place, decided at boot from STORAGE_DRIVER.
 *
 *   local  the laptop's own disk under KAIROS_DATA_ROOT/storage  (default)
 *   s3     MinIO, AWS S3, Cloudflare R2, or any S3-compatible endpoint
 *
 * `local` is the default because the premise of this platform is that the
 * machine in front of you *is* the storage. Running MinIO on the same laptop
 * to store files on the same disk adds a process, a network hop and a second
 * set of credentials to reach the same bytes.
 *
 * `s3` is the migration path: point it at a NAS, a VPS or a cloud bucket and
 * nothing above this module changes.
 */
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { LocalStorageDriver } from './local-driver.js';
import { S3StorageDriver } from './s3-driver.js';
import type { StorageDriver } from './driver.js';

function build(): StorageDriver {
  if (env.STORAGE_DRIVER === 's3') {
    logger.info({ endpoint: env.S3_ENDPOINT }, 'storage driver: s3');
    return new S3StorageDriver();
  }
  logger.info({ root: env.KAIROS_DATA_ROOT }, 'storage driver: local disk');
  return new LocalStorageDriver();
}

export const storage: StorageDriver = build();

export type { StorageDriver, StoredObject, SignOptions } from './driver.js';
export { verifySignedToken } from './local-driver.js';
export { s3 } from './s3-driver.js';
