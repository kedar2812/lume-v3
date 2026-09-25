import { asc, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { schema } from "@lume/db";

/**
 * Names for everyone who works leads: owners on rows, the owner filter, the assign picker. Names only;
 * emails, roles and status details stay behind users.manage. Disabled people stay listed (their old
 * leads still show who handled them) and are marked inactive so pickers can leave them out; people who
 * haven't accepted their invite yet aren't listed at all.
 */
export async function peopleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/people", { config: { permission: "leads.view" } }, async (req) => {
    const rows = await req.db
      .select({ id: schema.users.id, name: schema.users.name, status: schema.users.status })
      .from(schema.users)
      .where(ne(schema.users.status, "invited"))
      .orderBy(asc(schema.users.name));
    return { people: rows.map((r) => ({ id: r.id, name: r.name, active: r.status === "active" })) };
  });
}
