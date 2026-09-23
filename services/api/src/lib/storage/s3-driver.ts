/**
 * S3 driver — MinIO, AWS S3, Cloudflare R2 or anything else speaking the API.
 *
 * One physical bucket per project (`kairos-<ref>`); logical buckets are a key
 * prefix inside it. That keeps bucket counts sane (S3 caps them, MinIO does
 * not but listing gets slow) while still giving each project a hard namespace.
 */
import { Readable } from 'node:stream';
import {
  CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand,
  HeadBucketCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { ApiError } from '../errors.js';
import type { SignOptions, StorageDriver, StoredObject } from './driver.js';

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
});

const physicalBucket = (projectRef: string) => `kairos-${projectRef}`;

export class S3StorageDriver implements StorageDriver {
  readonly name = 's3' as const;

  async ensureNamespace(projectRef: string): Promise<void> {
    const bucket = physicalBucket(projectRef);
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (error) {
        logger.error({ err: error, bucket }, 'could not create storage bucket');
        throw new ApiError('STORAGE_ERROR', 'Storage is unavailable for this project');
      }
    }
  }

  async put(projectRef: string, key: string, body: Readable, contentType: string): Promise<{ size: number }> {
    await this.ensureNamespace(projectRef);
    let size = 0;
    body.on('data', (chunk: Buffer) => { size += chunk.length; });

    try {
      // Multipart upload streams the body; an 8 GB file costs a few MB of RAM
      // rather than being buffered whole.
      const upload = new Upload({
        client: s3,
        params: { Bucket: physicalBucket(projectRef), Key: key, Body: body, ContentType: contentType },
        queueSize: 4,
        partSize: 8 * 1024 * 1024,
      });
      await upload.done();
    } catch (error) {
      logger.error({ err: error, projectRef, key }, 's3 upload failed');
      throw new ApiError('STORAGE_ERROR', 'The file could not be stored');
    }

    return { size };
  }

  async get(projectRef: string, key: string): Promise<StoredObject> {
    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: physicalBucket(projectRef), Key: key }));
      return {
        stream: result.Body as Readable,
        contentType: result.ContentType ?? 'application/octet-stream',
        contentLength: result.ContentLength,
      };
    } catch {
      throw new ApiError('NOT_FOUND', 'File not found');
    }
  }

  async remove(projectRef: string, key: string): Promise<void> {
    await s3
      .send(new DeleteObjectCommand({ Bucket: physicalBucket(projectRef), Key: key }))
      .catch(() => undefined);
  }

  async usage(projectRef: string): Promise<number> {
    let total = 0;
    let token: string | undefined;
    do {
      const page = await s3
        .send(new ListObjectsV2Command({ Bucket: physicalBucket(projectRef), ContinuationToken: token }))
        .catch(() => null);
      if (!page) break;
      for (const object of page.Contents ?? []) total += object.Size ?? 0;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return total;
  }

  async removeNamespace(projectRef: string): Promise<void> {
    const bucket = physicalBucket(projectRef);
    let token: string | undefined;
    do {
      const page = await s3
        .send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }))
        .catch(() => null);
      if (!page) break;
      for (const object of page.Contents ?? []) {
        if (object.Key) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key })).catch(() => undefined);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    await s3.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
  }

  async signedUrl(projectRef: string, key: string, options: SignOptions): Promise<string> {
    const command =
      options.action === 'upload'
        ? new PutObjectCommand({ Bucket: physicalBucket(projectRef), Key: key })
        : new GetObjectCommand({ Bucket: physicalBucket(projectRef), Key: key });
    return getSignedUrl(s3, command, { expiresIn: options.expiresIn });
  }
}
