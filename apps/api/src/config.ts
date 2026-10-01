import { z } from 'zod';

/** Accepts true/false, 1/0, yes/no, on/off in any case; unset stays undefined so callers can pick a default. */
const looseBool = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return v; // let zod report it
}, z.boolean().optional());
const bool = looseBool.transform((v) => v ?? false);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:4001'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool,
  SESSION_SECRET: z.string().min(32),
  COOKIE_SECURE: looseBool,
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
  STORAGE_TOTAL_BYTES: z.coerce.number().default(10 * 1024 ** 4),
  MAX_UPLOAD_BYTES: z.coerce.number().default(100 * 1024 * 1024),
  MAX_VIDEO_BYTES: z.coerce.number().default(2 * 1024 * 1024 * 1024),
  /** Concurrent video transcodes per worker process (CPU heavy). */
  WORKER_VIDEO_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
  /**
   * Protection against forged cross-site requests that replay a signed-in user's cookie.
   *  host   (default) the request's Origin must be the host the browser actually used: needs no configuration.
   *  strict the Origin must equal PUBLIC_WEB_URL (or a CORS_ORIGINS site).
   *  off    no check (SameSite=Lax cookies remain the only protection).
   */
  ORIGIN_CHECK: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(['host', 'strict', 'off']).default('host')),
  /** Browser origins allowed to call the API: "*" (any site), or a comma-separated list. Empty = only the web app. */
  CORS_ORIGINS: z.string().default(''),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  TRUST_PROXY: looseBool,
  LOGIN_RATE_LIMIT: z.coerce.number().default(10),
  METRICS_TOKEN: z.string().min(16).optional(),
  // Case-insensitive; an invalid level would otherwise crash the logger at startup.
  LOG_LEVEL: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')),
});

// COOKIE_SECURE / TRUST_PROXY are resolved to plain booleans (see loadConfig).
export type Config = Omit<z.infer<typeof schema>, 'COOKIE_SECURE' | 'TRUST_PROXY'> & { COOKIE_SECURE: boolean; TRUST_PROXY: boolean };

export function loadConfig(input: NodeJS.ProcessEnv = process.env): Config {
  // Platforms (Docker Compose interpolation, Coolify, ...) pass unset optional variables as empty strings.
  const env = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  // An https public URL means TLS terminates at a reverse proxy in front of us: secure cookies and proxy trust follow.
  const https = parsed.data.PUBLIC_WEB_URL.startsWith('https://');
  const config: Config = { ...parsed.data, COOKIE_SECURE: parsed.data.COOKIE_SECURE ?? https, TRUST_PROXY: parsed.data.TRUST_PROXY ?? https };
  if (config.NODE_ENV === 'production') {
    if (https && !config.COOKIE_SECURE) throw new Error('COOKIE_SECURE=false with an https PUBLIC_WEB_URL: session cookies would be sent over plain HTTP. Remove COOKIE_SECURE or set it to true.');
    if (/change-?me/i.test(config.SESSION_SECRET)) throw new Error('SESSION_SECRET is still the placeholder value; generate a real one (openssl rand -hex 32)');
  }
  return config;
}
