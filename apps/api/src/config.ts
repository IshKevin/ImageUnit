import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

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
  COOKIE_SECURE: bool,
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
  STORAGE_TOTAL_BYTES: z.coerce.number().default(10 * 1024 ** 4),
  MAX_UPLOAD_BYTES: z.coerce.number().default(100 * 1024 * 1024),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  TRUST_PROXY: bool,
  LOGIN_RATE_LIMIT: z.coerce.number().default(10),
  METRICS_TOKEN: z.string().min(16).optional(),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(input: NodeJS.ProcessEnv = process.env): Config {
  // Platforms (Docker Compose interpolation, Coolify, ...) pass unset optional variables as empty strings.
  const env = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    if (!parsed.data.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    if (/change-?me/i.test(parsed.data.SESSION_SECRET)) throw new Error('SESSION_SECRET is still the placeholder value; generate a real one (openssl rand -hex 32)');
  }
  return parsed.data;
}
