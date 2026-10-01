import { getTableName, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Fully-qualified column reference. Drizzle omits the table name in single-table queries, which makes
 * a correlated reference to the outer table resolve to the subquery's own column instead.
 */
export const q = (c: AnyPgColumn) => sql.raw(`"${getTableName(c.table)}"."${c.name}"`);

/**
 * Lists as a single JSON parameter. Drizzle expands a JS array into a row tuple `($1, $2, ...)`, not a Postgres array,
 * and 20,000 separate parameters would also exceed PostgreSQL's limit; one jsonb parameter works at any size.
 */
export const uuidSet = (ids: string[]) => sql`(select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;
export const textArray = (values: string[]) => sql`array(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
