"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import type { ApiResult } from "@/lib/api";
import type { Catalog, FieldDefView } from "@/lib/leads/types";
import { fieldsClient, type FieldPatch } from "@/lib/settings/fields";
import { accessGone } from "@/lib/settings/access";
import { AccessChanged } from "./AccessChanged";
import { FieldPreview } from "./FieldPreview";
import { ListEditor } from "./ListEditor";
import s from "./settings.module.css";

type FieldType = FieldDefView["type"];
const TYPES: [FieldType, string][] = [
  ["text", "Short text"],
  ["long_text", "Long text"],
  ["number", "Number"],
  ["currency", "Amount"],
  ["date", "Date"],
  ["datetime", "Date and time"],
  ["boolean", "Yes or no"],
  ["select", "One choice"],
  ["multi_select", "Several choices"],
  ["phone", "Phone"],
  ["email", "Email"],
  ["url", "Link"],
  ["instagram", "Instagram"],
  ["user", "Person"],
];
const typeName = (t: FieldType) => TYPES.find(([k]) => k === t)?.[1] ?? t;
const hasOptions = (t: FieldType) => t === "select" || t === "multi_select";

type DraftOption = { id: string; label: string; color?: string; isNew?: boolean };
type Draft = {
  id?: string;
  isCore: boolean;
  label: string;
  type: FieldType;
  isRequired: boolean;
  options: DraftOption[];
};

/** A key the API accepts (`^[a-z][a-z0-9_]{0,39}$`) made from the name, never one already used. */
export function keyFor(label: string, taken: Set<string>): string {
  let base =
    label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "field";
  if (!/^[a-z]/.test(base)) base = `f_${base}`;
  base = base.slice(0, 36).replace(/_+$/, "");
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

const draftOf = (f: FieldDefView): Draft => ({
  id: f.id,
  isCore: f.isCore,
  label: f.label,
  type: f.type,
  isRequired: f.isRequired,
  options: f.options
    .filter((o) => !o.archived)
    .map((o) => ({ id: o.id, label: o.label, ...(o.color ? { color: o.color } : {}) })),
});
const blank = (): Draft => ({ isCore: false, label: "", type: "text", isRequired: false, options: [] });

/**
 * The lead's fields: the list on one side, the one being made or edited on the other, and below it
 * the lead form as it will look. Built-in fields can only be renamed. A field's type is fixed once it
 * exists; options keep their ids when renamed, so no lead loses its value; fields are archived, never deleted.
 */
export function FieldsEditor({ catalog }: { catalog: Catalog }) {
  const [fields, setFields] = useState(catalog.fields);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<{ label?: string; options?: string }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [nextOption, setNextOption] = useState(0);

  if (forbidden) return <AccessChanged />;

  const live = fields.filter((f) => !f.archived);
  const archived = fields.filter((f) => f.archived);
  const original = draft?.id ? fields.find((f) => f.id === draft.id) : undefined;

  const edit = (next: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...next } : d));
    setSaved(null);
    setProblem(null);
    setErrors((e) => ({
      ...e,
      ...("label" in next ? { label: undefined } : {}),
      ...("options" in next ? { options: undefined } : {}),
    }));
  };
  const open = (d: Draft | null) => {
    setDraft(d);
    setErrors({});
    setProblem(null);
    setSaved(null);
  };

  const landed = <T,>(r: ApiResult<T>): r is Extract<ApiResult<T>, { ok: true }> => {
    if (r.ok) return true;
    if (accessGone(r)) setForbidden(true);
    else setProblem(r.message || "That couldn’t be saved. Try again.");
    return false;
  };

  /** Only what changed, in the shape the API takes: existing options by id, new ones by name alone. */
  const changes = (d: Draft, f: FieldDefView): FieldPatch => {
    const out: FieldPatch = {};
    if (d.label.trim() !== f.label) out.label = d.label.trim();
    if (f.isCore) return out;
    if (d.isRequired !== f.isRequired) out.isRequired = d.isRequired;
    const before = draftOf(f).options;
    const same =
      before.length === d.options.length &&
      before.every((o, i) => o.id === d.options[i]!.id && o.label === d.options[i]!.label);
    if (hasOptions(f.type) && !same)
      out.options = d.options.map((o) =>
        o.isNew ? { label: o.label } : { id: o.id, label: o.label, ...(o.color ? { color: o.color } : {}) },
      );
    return out;
  };
  const patch = draft && original ? changes(draft, original) : null;
  const dirty = draft ? (original ? Object.keys(patch!).length > 0 : true) : false;

  const save = async () => {
    if (!draft) return;
    const label = draft.label.trim();
    const problems = {
      label: label ? undefined : "Give the field a name",
      options: hasOptions(draft.type) && draft.options.length === 0 ? "Add at least one option" : undefined,
    };
    setErrors(problems);
    if (problems.label || problems.options) return;
    setBusy(true);
    const r = original
      ? await fieldsClient.patch(original.id, patch!)
      : await fieldsClient.create({
          key: keyFor(label, new Set(fields.map((f) => f.key))),
          label,
          type: draft.type,
          ...(hasOptions(draft.type) ? { options: draft.options.map((o) => ({ label: o.label })) } : {}),
          isRequired: draft.isRequired,
        });
    setBusy(false);
    if (!landed(r)) return;
    const field = r.data.field;
    setFields((all) =>
      all.some((f) => f.id === field.id) ? all.map((f) => (f.id === field.id ? field : f)) : [...all, field],
    );
    setDraft(draftOf(field));
    setSaved(original ? "Saved" : `${field.label} added`);
  };

  const archive = async () => {
    if (!original) return;
    setAsking(false);
    const r = await fieldsClient.archive(original.id);
    if (!landed(r)) return;
    setFields((all) => all.map((f) => (f.id === original.id ? { ...f, archived: true } : f)));
    setDraft(null);
    setSaved(`${original.label} archived`);
  };

  const preview: FieldDefView[] = (() => {
    if (!draft) return live;
    const def: FieldDefView = {
      id: draft.id ?? "draft",
      key: original?.key ?? "draft",
      label: draft.label.trim() || "New field",
      type: draft.type,
      options: draft.options.map((o) => ({ id: o.id, label: o.label })),
      isCore: draft.isCore,
      isRequired: draft.isRequired,
      archived: false,
      access: "edit",
    };
    return draft.id ? live.map((f) => (f.id === draft.id ? def : f)) : [...live, def];
  })();

  return (
    <div className={s.fieldsLayout}>
      <div className={s.fieldList}>
        <ul className={s.listCard}>
          {live.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className={s.fieldRow}
                aria-label={`Edit ${f.label}`}
                aria-current={draft?.id === f.id || undefined}
                onClick={() => open(draftOf(f))}
              >
                <span className={s.fieldRowName}>{f.label}</span>
                <span className={s.fieldRowMeta}>
                  {f.isCore ? "Built in" : typeName(f.type)}
                  {f.isRequired && " · needed"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" onClick={() => open(blank())}>
          Add a field
        </Button>
        {archived.length > 0 && (
          <p className={s.muted}>Archived: {archived.map((f) => f.label).join(", ")}</p>
        )}
      </div>

      <div className={s.stack}>
        {draft ? (
          // Not a <form>: the options list has its own add form inside, and forms can't nest.
          <section className={s.panel} aria-label={original ? `Edit ${original.label}` : "New field"}>
            <div className={s.panelHead}>
              <h2 className={s.panelTitle}>{original ? original.label : "New field"}</h2>
            </div>
            <div className={s.panelBody}>
              <Field label="Field name" error={errors.label}>
                {(control) => (
                  <input
                    {...control}
                    value={draft.label}
                    maxLength={60}
                    autoFocus={!original}
                    onChange={(e) => edit({ label: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      void save();
                    }}
                  />
                )}
              </Field>
              <Field
                label="Type"
                hint={
                  original
                    ? "A field’s type can’t change once it exists. Make a new field instead."
                    : undefined
                }
              >
                {(control) => (
                  <select
                    {...control}
                    value={draft.type}
                    disabled={!!original}
                    onChange={(e) => edit({ type: e.target.value as FieldType })}
                  >
                    {TYPES.map(([k, name]) => (
                      <option key={k} value={k}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {draft.isCore ? (
                <p className={s.muted}>
                  Built-in fields can be renamed. To hide one from a role, use Roles &amp; access.
                </p>
              ) : (
                <label className={s.check}>
                  <input
                    type="checkbox"
                    checked={draft.isRequired}
                    onChange={(e) => edit({ isRequired: e.target.checked })}
                  />
                  Needed before a lead is saved
                </label>
              )}
              {hasOptions(draft.type) && !draft.isCore && (
                <div className={s.optionsBlock}>
                  <p className={s.blockLabel}>Options</p>
                  <ListEditor
                    items={draft.options}
                    itemLabel="Option"
                    addLabel="Add an option"
                    archiveNote="Leads that have it keep it; it just can’t be picked any more."
                    onAdd={(label) => {
                      edit({ options: [...draft.options, { id: `new-${nextOption}`, label, isNew: true }] });
                      setNextOption((n) => n + 1);
                    }}
                    onRename={(id, label) =>
                      edit({ options: draft.options.map((o) => (o.id === id ? { ...o, label } : o)) })
                    }
                    onReorder={(ids) =>
                      edit({ options: ids.map((id) => draft.options.find((o) => o.id === id)!) })
                    }
                    onArchive={(id) => edit({ options: draft.options.filter((o) => o.id !== id) })}
                  />
                  {errors.options && (
                    <p role="alert" className={s.problem}>
                      {errors.options}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className={s.panelFoot}>
              {saved && (
                <p role="status" className={s.saved}>
                  {saved}
                </p>
              )}
              {problem && (
                <p role="alert" className={s.problem}>
                  {problem}
                </p>
              )}
              {original && !original.isCore && (
                <Button
                  variant="ghost"
                  onClick={() => setAsking(true)}
                  aria-label={`Archive ${original.label}`}
                >
                  Archive
                </Button>
              )}
              <Button variant="ghost" onClick={() => open(null)}>
                Close
              </Button>
              <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
                {original ? "Save field" : "Create field"}
              </Button>
            </div>
          </section>
        ) : (
          saved && (
            <p role="status" className={s.saved}>
              {saved}
            </p>
          )
        )}
        <FieldPreview
          catalog={catalog}
          fields={preview}
          focusId={draft ? (draft.id ?? "draft") : undefined}
        />
      </div>

      {asking && original && (
        <Dialog label={`Archive ${original.label}?`} onClose={() => setAsking(false)}>
          <h2 className={s.dialogTitle}>Archive {original.label}?</h2>
          <p className={s.dialogText}>
            It stops showing on forms and in the table. Every lead keeps what’s in it, and the audit log keeps
            its history.
          </p>
          <div className={s.dialogActions}>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void archive()}>
              Archive field
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
