import { can } from "@lume/core/shared";
import { TemplateLibrary } from "@/components/templates/TemplateLibrary";
import type { EditorField } from "@/components/templates/TemplateEditor";
import type { FieldDefView } from "@/lib/leads/types";
import type { RoleName, TemplateView } from "@/lib/templates/client";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Templates · LUME" };

export default async function Page() {
  const session = await requirePermission("templates.use");
  const [list, defs] = await Promise.all([
    apiGet<{ templates: TemplateView[]; roles?: RoleName[] }>("/api/v1/templates"),
    apiGet<{ fields: FieldDefView[] }>("/api/v1/fields"),
  ]);
  // The business's own fields become variables; the built-in ones already are, and archived ones are gone.
  const fields: EditorField[] = (defs.data?.fields ?? [])
    .filter((f) => !f.isCore && !f.archived && f.access !== "hidden")
    .map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      options: f.options.filter((o) => !o.archived).map((o) => ({ id: o.id, label: o.label })),
    }));
  return (
    <section data-stagger>
      <TemplateLibrary
        initial={list.data?.templates ?? []}
        roles={list.data?.roles ?? []}
        fields={fields}
        canManage={can(session.actor, "templates.manage")}
      />
    </section>
  );
}
