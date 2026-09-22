import { asc, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { buildCustomFieldSchemas, type FieldDef } from "@lume/core";
import { schema } from "@lume/db";

export type FieldRegistry = {
  version: number;
  defaultCountry: string | null;
  defs: FieldDef[];
  byKey: ReadonlyMap<string, FieldDef>;
  byId: ReadonlyMap<string, FieldDef>;
  custom: ReturnType<typeof buildCustomFieldSchemas>;
};

declare module "fastify" {
  interface FastifyInstance {
    fieldRegistryCache: { value: FieldRegistry | null };
  }
}

/**
 * Field definitions + compiled custom-field schemas, rebuilt only when settings.field_defs_version (or the
 * default country) changes. Cached per app instance, so tests with separate databases never share it.
 */
export async function loadFieldRegistry(req: FastifyRequest): Promise<FieldRegistry> {
  const [s] = await req.db
    .select({ version: schema.settings.fieldDefsVersion, country: schema.settings.defaultCountryIso })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  const version = s?.version ?? 0;
  const defaultCountry = s?.country ?? null;
  const cache = req.server.fieldRegistryCache;
  if (cache.value && cache.value.version === version && cache.value.defaultCountry === defaultCountry)
    return cache.value;
  const rows = await req.db
    .select()
    .from(schema.fieldDefinitions)
    .orderBy(asc(schema.fieldDefinitions.position), asc(schema.fieldDefinitions.key));
  const defs: FieldDef[] = rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    type: r.type,
    options: r.options,
    isCore: r.isCore,
    isRequired: r.isRequired,
    archived: r.archivedAt !== null,
  }));
  cache.value = {
    version,
    defaultCountry,
    defs,
    byKey: new Map(defs.map((d) => [d.key, d])),
    byId: new Map(defs.map((d) => [d.id, d])),
    custom: buildCustomFieldSchemas(defs, { defaultCountry }),
  };
  return cache.value;
}

/** Call in the same transaction as any field-definition change (or default-country change). */
export async function bumpFieldDefs(req: FastifyRequest): Promise<void> {
  await req.db.execute(sql`UPDATE settings SET field_defs_version = field_defs_version + 1 WHERE id = 1`);
}
