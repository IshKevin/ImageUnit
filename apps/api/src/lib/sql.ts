import { getTableName, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Fully-qualified column reference. Drizzle omits the table name in single-table queries, which makes
 * a correlated reference to the outer table resolve to the subquery's own column instead.
 */
export const q = (c: AnyPgColumn) => sql.raw(`"${getTableName(c.table)}"."${c.name}"`);
