"use client";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  TEMPLATE_CATEGORIES,
  VARIABLES,
  render,
  type FieldType,
  type RenderContext,
  type TemplateCategory,
  type Variable,
} from "@lume/core/shared";
import d from "@/components/leads/drawer/drawer.module.css";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { leadsClient } from "@/lib/leads/client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { templatesClient, type RoleName, type TemplateView } from "@/lib/templates/client";
import { VariablePicker } from "./VariablePicker";
import { WhatsAppBubble } from "./WhatsAppBubble";
import s from "./templates.module.css";

const LONG = 1000; // past this, WhatsApp messages get cut into "Read more"
const MAX = 4096;
/** Until a real lead is picked, the preview reads as a sample (fictional names, never a client's). */
const SAMPLE: RenderContext = {
  lead: { name: "Alex Morgan", custom: {} },
  owner: { name: "Sam Lee" },
  business: { name: "your business", currency: "", timezone: "UTC" },
  fields: [],
  people: [],
};
export type EditorField = {
  key: string;
  label: string;
  type: FieldType;
  options?: { id: string; label: string }[];
};

/**
 * A template's editor (Phase 4A; frontend spec §8.9): the words on the left, and on the right the message
 * as WhatsApp will show it, for a sample or a real lead. The preview renders locally on every keystroke;
 * the server renders again only when it's sent. Saving an edit to the words makes the next version.
 */
export function TemplateEditor({
  template,
  roles,
  fields,
  readOnly,
  onSaved,
  onClose,
}: {
  template?: TemplateView;
  roles: RoleName[];
  fields: EditorField[];
  readOnly: boolean;
  onSaved: (t: TemplateView) => void;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const titleId = useId();
  const bodyId = useId();
  const [name, setName] = useState(template?.name ?? "");
  const [category, setCategory] = useState<TemplateCategory>(template?.category ?? "first_touch");
  const [body, setBody] = useState(template?.body ?? "");
  const [onlyRoles, setOnlyRoles] = useState((template?.allowedRoleIds.length ?? 0) > 0);
  const [roleIds, setRoleIds] = useState<string[]>(template?.allowedRoleIds ?? []);
  const [saved, setSaved] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [context, setContext] = useState<RenderContext | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const variables = useMemo(() => VARIABLES(fields), [fields]);
  const [suggest, setSuggest] = useState<{ start: number; options: Variable[]; active: number } | null>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && !suggest && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, suggest]);

  const ctx: RenderContext = context ?? {
    ...SAMPLE,
    fields: fields.map((f) => ({ ...f, options: f.options ?? [] })),
  };
  const preview = render(body, ctx);
  const touched = () => {
    setSaved(null);
    setProblem(null);
  };

  /** Put `{{token}}` in place of [from, to) and leave the caret just after it. */
  const insertAt = (from: number, to: number, token: string) => {
    const text = `{{${token}}}`;
    setBody((b) => b.slice(0, from) + text + b.slice(to));
    setSuggest(null);
    touched();
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(from + text.length, from + text.length);
    });
  };
  const insertAtCaret = (token: string) => {
    const el = area.current;
    const at = el?.selectionStart ?? body.length;
    insertAt(at, el?.selectionEnd ?? at, token);
  };

  /** "{{" before the caret opens the variables, narrowed as you type. */
  const lookForBraces = (text: string, caret: number) => {
    const m = /\{\{([\w.]*)$/.exec(text.slice(0, caret));
    if (!m) return setSuggest(null);
    const q = m[1]!.toLowerCase();
    const options = variables.filter(
      (v) => !v.needs && (v.token.toLowerCase().includes(q) || v.label.toLowerCase().includes(q)),
    );
    setSuggest(options.length ? { start: caret - m[0].length, options, active: 0 } : null);
  };
  const onBodyKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!suggest) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSuggest({
        ...suggest,
        active: (suggest.active + step + suggest.options.length) % suggest.options.length,
      });
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insertAt(suggest.start, e.currentTarget.selectionStart, suggest.options[suggest.active]!.token);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setSuggest(null);
    }
  };

  const save = async () => {
    if (!name.trim()) return setProblem("Give the template a name.");
    if (!body.trim()) return setProblem("Write the message.");
    if (onlyRoles && !roleIds.length) return setProblem("Pick at least one role, or let everyone use it.");
    setBusy(true);
    setProblem(null);
    const input = { name: name.trim(), category, body, allowedRoleIds: onlyRoles ? roleIds : [] };
    const r = template
      ? await templatesClient.update(template.id, input)
      : await templatesClient.create(input);
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    setSaved(`Saved as version ${r.data.version}`);
    onSaved(r.data);
  };

  const count = body.length;
  return (
    <>
      <motion.div
        className={d.scrim}
        onClick={onClose}
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />
      <motion.form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`${d.drawer} ${s.editor}`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly) void save();
        }}
        initial={reduce ? { opacity: 0, x: 0 } : { opacity: 1, x: "calc(100% + 24px)" }}
        animate={{ opacity: 1, x: 0 }}
        exit={reduce ? { opacity: 0, x: 0 } : { opacity: 1, x: "calc(100% + 24px)" }}
        transition={toMotion(SPRINGS.drawer)}
      >
        <div className={d.top}>
          <IconButton label="Close (Esc)" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </IconButton>
          <h2 id={titleId} className={s.editorTitle}>
            {template?.name ?? "New template"}
          </h2>
          {template && <span className={s.version}>Version {template.version}</span>}
        </div>

        <div className={s.panes}>
          <div className={s.words}>
            <label className={s.label} htmlFor={`${bodyId}-name`}>
              Name
            </label>
            <input
              id={`${bodyId}-name`}
              className={s.input}
              aria-label="Name"
              maxLength={80}
              readOnly={readOnly}
              value={name}
              placeholder="e.g. Gentle nudge"
              onChange={(e) => {
                setName(e.target.value);
                touched();
              }}
            />

            <span className={s.label} id={`${bodyId}-cat`}>
              Kind
            </span>
            <div role="radiogroup" aria-labelledby={`${bodyId}-cat`} className={s.seg}>
              {TEMPLATE_CATEGORIES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={category === c.key}
                  className={s.segBtn}
                  disabled={readOnly}
                  onClick={() => {
                    setCategory(c.key);
                    touched();
                  }}
                >
                  {category === c.key && (
                    <motion.span
                      layoutId={`${bodyId}-thumb`}
                      className={s.segThumb}
                      transition={reduce ? { duration: 0 } : toMotion(SPRINGS.default)}
                      aria-hidden
                    />
                  )}
                  <span className={s.segLabel}>{c.label}</span>
                </button>
              ))}
            </div>

            <label className={s.label} htmlFor={bodyId}>
              Message
            </label>
            {!readOnly && <VariablePicker variables={variables} onInsert={insertAtCaret} />}
            <div className={s.bodyWrap}>
              <textarea
                ref={area}
                id={bodyId}
                aria-label="Message"
                className={s.body}
                rows={9}
                maxLength={MAX}
                readOnly={readOnly}
                value={body}
                placeholder="Hi {{lead.first_name}}, …"
                aria-autocomplete="list"
                aria-expanded={!!suggest}
                onChange={(e) => {
                  setBody(e.target.value);
                  touched();
                  lookForBraces(e.target.value, e.target.selectionStart);
                }}
                onKeyDown={onBodyKey}
                onBlur={() => setSuggest(null)}
              />
              {suggest && (
                <ul role="listbox" aria-label="Variables" className={s.suggest}>
                  {suggest.options.map((v, i) => (
                    <li
                      key={v.token}
                      role="option"
                      aria-selected={i === suggest.active}
                      className={s.suggestItem}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertAt(suggest.start, area.current?.selectionStart ?? body.length, v.token);
                      }}
                    >
                      {v.label}
                      <code aria-hidden>{`{{${v.token}}}`}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className={s.count} data-long={count > LONG || undefined}>
              <span>
                {count.toLocaleString("en")} / {MAX.toLocaleString("en")}
              </span>
              {count > LONG && " · Long for WhatsApp: it shows “Read more” after the first lines."}
            </p>

            <span className={s.label} id={`${bodyId}-who`}>
              Who can use it
            </span>
            <div role="radiogroup" aria-labelledby={`${bodyId}-who`} className={s.whoChoice}>
              {(
                [
                  [false, "Everyone"],
                  [true, "Only these roles"],
                ] as const
              ).map(([only, label]) => (
                <label key={label} className={s.radio}>
                  <input
                    type="radio"
                    name={`${bodyId}-who`}
                    checked={onlyRoles === only}
                    disabled={readOnly}
                    onChange={() => {
                      setOnlyRoles(only);
                      touched();
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
            {onlyRoles && (
              <div className={s.roles}>
                {roles.map((r) => {
                  const on = roleIds.includes(r.id);
                  return (
                    <label key={r.id} className={s.pill} data-on={on || undefined}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={readOnly}
                        onChange={(e) => {
                          setRoleIds((ids) =>
                            e.target.checked ? [...ids, r.id] : ids.filter((x) => x !== r.id),
                          );
                          touched();
                        }}
                      />
                      {r.name}
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <aside className={s.previewPane} aria-label="How it will look">
            <PreviewAs onContext={setContext} />
            <WhatsAppBubble text={preview.text} />
            {preview.missing.length > 0 && (
              <p className={s.missing}>
                {context ? "Nothing to fill in for " : "Filled in when sent: "}
                {preview.missing.map((m) => `{{${m}}}`).join(", ")}
              </p>
            )}
          </aside>
        </div>

        {!readOnly && (
          <div className={s.foot}>
            {problem ? (
              <p role="alert" className={s.problem}>
                {problem}
              </p>
            ) : (
              saved && (
                <p role="status" className={s.saved}>
                  {saved}
                </p>
              )
            )}
            <Button type="submit" variant="primary" loading={busy}>
              Save
            </Button>
          </div>
        )}
      </motion.form>
    </>
  );
}

/** "Preview as": pick a real lead (names only); their preview context is fetched once. */
function PreviewAs({ onContext }: { onContext: (c: RenderContext | null) => void }) {
  const id = useId();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!q.trim() || picked === q) return setOptions([]);
    let live = true;
    const t = setTimeout(() => {
      void leadsClient.list({ q, stageIds: [], sort: "newest" }, undefined, 6).then((r) => {
        if (live && r.ok) {
          setOptions(r.data.items.map((l) => ({ id: l.id, name: l.name ?? "Unnamed lead" })));
          setOpen(true);
        }
      });
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, picked]);

  const pick = async (l: { id: string; name: string }) => {
    setQ(l.name);
    setPicked(l.name);
    setOpen(false);
    const r = await templatesClient.context(l.id);
    onContext(r.ok ? r.data : null);
  };

  return (
    <div className={s.previewAs}>
      <label htmlFor={id} className={s.label}>
        Preview as
      </label>
      <input
        id={id}
        role="combobox"
        aria-label="Preview as"
        aria-expanded={open && options.length > 0}
        aria-controls={`${id}-list`}
        className={s.input}
        placeholder="A sample lead · type a name"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPicked(null);
          if (!e.target.value.trim()) onContext(null);
        }}
      />
      {open && options.length > 0 && (
        <ul id={`${id}-list`} role="listbox" aria-label="Leads" className={s.suggest}>
          {options.map((l) => (
            <li
              key={l.id}
              role="option"
              aria-selected={false}
              className={s.suggestItem}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void pick(l)}
            >
              {l.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
