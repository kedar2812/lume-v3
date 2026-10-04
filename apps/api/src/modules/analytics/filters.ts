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

/** Live filters read each lead, so their range is bounded (8D spec §4: 92 days). */
export const LIVE_MAX_DAYS = 92;
type LiveFilters = { tagIds?: readonly string[]; fields?: Readonly<Record<string, readonly string[]>> };
export const isLive = (q: LiveFilters) => !!(q.tagIds?.length || (q.fields && Object.keys(q.fields).length));

/**
 * The tag and field filters over leads `l`: any of the tags; for each field, any of its values. A value matches a
 * single-choice field (`{key: v}`) or a multiple-choice one (`{key: [v]}`); "true"/"false" match yes/no fields.
 */
export function liveFilter(q: LiveFilters): SQL | null {
  const parts: SQL[] = [];
  if (q.tagIds?.length)
    parts.push(sql`EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id = l.id
      AND lt.tag_id = ANY(${`{${q.tagIds.join(",")}}`}::uuid[]))`);
  for (const [key, values] of Object.entries(q.fields ?? {})) {
    const any = values.map((v) => {
      const value = v === "true" ? true : v === "false" ? false : v;
      return sql`(l.custom @> ${JSON.stringify({ [key]: value })}::jsonb OR l.custom @> ${JSON.stringify({ [key]: [value] })}::jsonb)`;
    });
    parts.push(sql`(${sql.join(any, sql` OR `)})`);
  }
  return parts.length ? sql.join(parts, sql` AND `) : null;
}
