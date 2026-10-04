import { sql, type SQL } from "drizzle-orm";

/**
 * The analytics filters as SQL (8D spec §4 Filters): several people (or "none", leads nobody owns), several sources.
 * A team arrives here already turned into its people (routes.ts). One place, so every module, rollup or live, narrows
 * the same way.
 */
export function ownerCond(ids: readonly string[] | undefined, col: SQL): SQL | null {
  if (!ids?.length) return null;
  const people = ids.filter((i) => i !== "none");
  const none = ids.includes("none");
  if (!people.length) return sql`${col} IS NULL`;
  const any = sql`${col} = ANY(${`{${people.join(",")}}`}::uuid[])`;
  return none ? sql`(${col} IS NULL OR ${any})` : any;
}

export function sourceCond(ids: readonly string[] | undefined, col: SQL): SQL | null {
  if (!ids?.length) return null;
  return sql`${col} = ANY(${`{${ids.join(",")}}`}::uuid[])`;
}

/** Each condition that applies, joined with AND (`true` when none do). */
export function and(...parts: (SQL | null | undefined)[]): SQL {
  const live = parts.filter((p): p is SQL => !!p);
  return live.length ? sql.join(live, sql` AND `) : sql`true`;
}
