import { hmac, randomToken, safeEqual, sha256 } from './crypto.js';

export const SCOPES = ['events:read', 'galleries:read', 'images:read', 'downloads:read'] as const;
export type Scope = (typeof SCOPES)[number];

export function generateApiKey() {
  const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
  const secret = randomToken(32);
  const key = `iu_live_${prefix}_${secret}`;
  return { key, keyPrefix: `iu_live_${prefix}`, keyHash: sha256(key) };
}

export const hashApiKey = sha256;

/** Short-lived signed media URLs let a website's browser load images without ever holding the API key. */
export function signMedia(secret: string, p: { photoId: string; kind: string; clientId: string; exp: number }) {
  return hmac(secret, `${p.photoId}|${p.kind}|${p.clientId}|${p.exp}`);
}

export function verifyMedia(secret: string, p: { photoId: string; kind: string; clientId: string; exp: number }, sig: string) {
  return p.exp > Math.floor(Date.now() / 1000) && safeEqual(sig, signMedia(secret, p));
}
