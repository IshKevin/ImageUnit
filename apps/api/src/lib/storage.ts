import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { Config } from '../config.js';

export interface ObjectInfo {
  size: number;
  contentType?: string;
}

/**
 * Storage abstraction. Nothing outside this module knows keys map to S3, so the
 * backing store can change without touching API consumers (spec §23).
 */
export interface Storage {
  ensureReady(): Promise<void>;
  presignUpload(key: string, contentType: string, ttlSeconds?: number): Promise<string>;
  presignDownload(key: string, opts: { filename?: string; ttlSeconds?: number; inline?: boolean }): Promise<string>;
  head(key: string): Promise<ObjectInfo | null>;
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(keys: string[]): Promise<void>;
  ping(): Promise<boolean>;
}

const streamToBuffer = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
};

export function createS3Storage(config: Config): Storage {
  const base = {
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    // The SDK's newer default attaches CRC32 checksums to every request, which most S3-compatible servers
    // (SeaweedFS, Garage, ...) reject with BadDigest. Only compute checksums when the operation requires one.
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
  };
  const internal = new S3Client({ ...base, endpoint: config.S3_ENDPOINT });
  // Presigned URLs are consumed by browsers, which may see a different hostname than the API does.
  const signer = new S3Client({ ...base, endpoint: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT });
  const Bucket = config.S3_BUCKET;

  return {
    async ensureReady() {
      try {
        await internal.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await internal.send(new CreateBucketCommand({ Bucket }));
      }
    },
    presignUpload: (key, contentType, ttl = 3600) =>
      getSignedUrl(signer, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), {
        expiresIn: ttl,
        signableHeaders: new Set(['content-type']),
      }),
    presignDownload: (key, { filename, ttlSeconds = 300, inline = true }) =>
      getSignedUrl(
        signer,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentDisposition: filename
            ? `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`
            : undefined,
        }),
        { expiresIn: ttlSeconds },
      ),
    async head(key) {
      try {
        const r = await internal.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: r.ContentLength ?? 0, contentType: r.ContentType };
      } catch (e) {
        if ((e as { name?: string }).name === 'NotFound') return null;
        throw e;
      }
    },
    async get(key) {
      const r = await internal.send(new GetObjectCommand({ Bucket, Key: key }));
      return streamToBuffer(r.Body as Readable);
    },
    async put(key, body, contentType) {
      await internal.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async delete(keys) {
      if (keys.length === 0) return;
      if (keys.length === 1) {
        await internal.send(new DeleteObjectCommand({ Bucket, Key: keys[0]! }));
        return;
      }
      for (let i = 0; i < keys.length; i += 1000) {
        await internal.send(
          new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }),
        );
      }
    },
    async ping() {
      try {
        await internal.send(new HeadBucketCommand({ Bucket }));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** In-memory implementation for tests. */
export function createMemoryStorage(): Storage & { objects: Map<string, { body: Buffer; contentType: string }> } {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    objects,
    async ensureReady() {},
    async presignUpload(key) {
      return `memory://upload/${key}`;
    },
    async presignDownload(key, { filename }) {
      return `memory://download/${key}${filename ? `?filename=${encodeURIComponent(filename)}` : ''}`;
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { size: o.body.length, contentType: o.contentType } : null;
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) throw new Error(`missing object ${key}`);
      return o.body;
    },
    async put(key, body, contentType) {
      objects.set(key, { body, contentType });
    },
    async delete(keys) {
      for (const k of keys) objects.delete(k);
    },
    async ping() {
      return true;
    },
  };
}
