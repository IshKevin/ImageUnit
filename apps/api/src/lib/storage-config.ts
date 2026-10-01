import type { Config } from '../config.js';

const INTERNAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|s3|minio)$/i;

/** True when the address only means something on the server itself (visitors' browsers could never reach it). */
export const isInternalHost = (hostname: string) => INTERNAL_HOST.test(hostname) || /^127\./.test(hostname);

/**
 * Browsers upload straight to object storage at S3_PUBLIC_ENDPOINT. Returns a plain-words problem when that address
 * cannot work for real visitors, or null when it looks usable. Only enforced in production: locally "localhost" is right.
 */
export function publicStorageProblem(config: Pick<Config, 'NODE_ENV' | 'S3_PUBLIC_ENDPOINT' | 'S3_ENDPOINT' | 'PUBLIC_WEB_URL'>): string | null {
  if (config.NODE_ENV !== 'production') return null;
  const raw = config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'S3_PUBLIC_ENDPOINT is not set to a valid address.';
  }
  if (isInternalHost(url.hostname)) {
    return `S3_PUBLIC_ENDPOINT is ${raw}, an address that only works on the server itself. Give the storage service a public domain (for example https://media.<your domain>) and set S3_PUBLIC_ENDPOINT to it.`;
  }
  if (config.PUBLIC_WEB_URL.startsWith('https://') && url.protocol === 'http:') {
    return `S3_PUBLIC_ENDPOINT (${raw}) is http but the site is https; browsers block that. Use an https address.`;
  }
  return null;
}
