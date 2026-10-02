import { sql } from "drizzle-orm";
import type { Db } from "../db/context";

/**
 * Networks as Postgres keeps them (6A final review): "86.98.40.12" is "86.98.40.12/32", and "192.168.1.10/24"
 * is "192.168.1.0/24" — a cidr column refuses host bits, so they're cleared here rather than failing the
 * save. In the order given, without repeats; null for none.
 */
export async function normaliseNetworks(db: Db, list: string[] | null | undefined): Promise<string[] | null> {
  if (!list?.length) return null;
  const { rows } = await db.execute(sql`
    SELECT network(x::inet)::text AS n FROM unnest(${`{${list.join(",")}}`}::text[]) WITH ORDINALITY u(x, i)
     ORDER BY i`);
  return [...new Set((rows as { n: string }[]).map((r) => r.n))];
}
