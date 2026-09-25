"use client";
import { CatalogProvider } from "@/components/leads/CatalogProvider";
import { FieldEditor } from "@/components/leads/fields/FieldEditor";
import type { Catalog, FieldDefView } from "@/lib/leads/types";
import s from "./settings.module.css";

/**
 * The lead form as a person adding a lead will see it, with the field being made or edited in place.
 * It's live: try the controls. Nothing typed here is saved.
 */
export function FieldPreview({
  catalog,
  fields,
  focusId,
}: {
  catalog: Catalog;
  fields: FieldDefView[];
  /** The field being edited, marked so it can be found at a glance. */
  focusId?: string;
}) {
  return (
    <section className={s.preview} aria-label="Lead form preview">
      <p className={s.previewTitle} aria-hidden>
        Lead form preview
      </p>
      <CatalogProvider catalog={{ ...catalog, fields }}>
        <div className={s.previewFields}>
          {fields.map((def) => (
            <div
              key={`${def.id}:${def.type}`}
              className={s.previewField}
              data-focus={def.id === focusId || undefined}
            >
              <p className={s.previewCaption} aria-hidden>
                {def.label}
                {def.isRequired && <span> · needed</span>}
              </p>
              <FieldEditor
                def={def}
                value={undefined}
                inForm
                onCommit={() => undefined}
                onCancel={() => undefined}
              />
            </div>
          ))}
        </div>
      </CatalogProvider>
    </section>
  );
}
