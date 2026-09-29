import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters.
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string) => hash(pw, ARGON);
export async function verifyPassword(hashed: string, pw: string) {
  try {
    return await verify(hashed, pw);
  } catch {
    return false;
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function hmac(secret: string, data: string) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Signed, expiring token: `<b64 payload>.<sig>`. Used for private-gallery access grants. */
export function signToken(secret: string, payload: Record<string, unknown>, ttlSeconds: number) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

export function verifyToken<T extends Record<string, unknown>>(secret: string, token: string): (T & { exp: number }) | null {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(secret, body))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as T & { exp: number };
    return data.exp > Math.floor(Date.now() / 1000) ? data : null;
  } catch {
    return null;
  }
}

/** Anonymous visitor identifier that rotates daily; raw IPs are never stored. */
export function visitorHash(secret: string, ip: string, ua: string) {
  const day = new Date().toISOString().slice(0, 10);
  return hmac(secret, `${day}|${ip}|${ua}`).slice(0, 22);
}
