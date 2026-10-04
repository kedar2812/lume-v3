import { api } from "@/lib/api";
import type { SettingsArea } from "./areas";
import type { SettingsHit } from "./index";

type Named = { id: string; name?: string; label?: string };

/**
 * The things this business made, findable from Settings: its stages, fields, tags, lost reasons, packages, roles,
 * teams and people, each pointing at the area where it's changed. Only the areas this person may open are asked
 * for; a list they can't read is simply left out.
 */
export async function loadYours(areas: SettingsArea[]): Promise<SettingsHit[]> {
  const has = new Set(areas.map((a) => a.id));
  const title = (id: string) => areas.find((a) => a.id === id)?.title ?? "Settings";
  const href = (id: string) => areas.find((a) => a.id === id)?.href ?? "/settings";
  const ask = <T>(id: string, path: string) =>
    has.has(id) ? api.get<T>(path).then((r) => (r.ok ? r.data : null)) : Promise.resolve(null);
  const [pipelines, fields, tags, reasons, products, roles, teams, people] = await Promise.all([
    ask<{ pipelines: { id: string; name: string; stages: Named[] }[] }>("pipeline", "/api/v1/pipelines"),
    ask<{ fields: (Named & { isCore?: boolean })[] }>("fields", "/api/v1/fields"),
    ask<{ tags: Named[] }>("lists", "/api/v1/tags"),
    ask<{ lostReasons: Named[] }>("lists", "/api/v1/lost-reasons"),
    ask<{ products: Named[] }>("lists", "/api/v1/products"),
    ask<{ roles?: Named[] }>("roles", "/api/v1/roles"),
    ask<{ teams?: Named[] }>("teams", "/api/v1/teams"),
    ask<{ people: Named[] }>("people", "/api/v1/people"),
  ]);
  const out: SettingsHit[] = [];
  const add = (area: string, kind: string, items: Named[] | undefined, extra: string[] = []) => {
    for (const x of items ?? []) {
      const label = x.name ?? x.label;
      if (!label) continue;
      out.push({
        id: `yours:${area}:${kind}:${x.id}`,
        label,
        where: `${title(area)} · ${kind}`,
        href: href(area),
        keywords: [kind.toLowerCase(), ...extra],
        kind: "yours",
      });
    }
  };
  for (const p of pipelines?.pipelines ?? []) add("pipeline", "Stage", p.stages, [p.name]);
  add("pipeline", "Pipeline", pipelines?.pipelines);
  add("fields", "Field", fields?.fields);
  add("lists", "Tag", tags?.tags);
  add("lists", "Lost reason", reasons?.lostReasons);
  add("lists", "Package", products?.products);
  add("roles", "Role", roles?.roles);
  add("teams", "Team", teams?.teams);
  add("people", "Person", people?.people);
  return out;
}
