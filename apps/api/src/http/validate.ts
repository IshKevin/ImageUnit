import type { z } from 'zod';
import { badRequest } from '../lib/errors.js';

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const pageParams = (q: { page?: number; pageSize?: number }) => {
  const pageSize = Math.min(Math.max(q.pageSize ?? 25, 1), 200);
  const page = Math.max(q.page ?? 1, 1);
  return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
};
