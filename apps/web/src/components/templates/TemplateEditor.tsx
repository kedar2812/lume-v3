"use client";
import { BodyPortal } from "@/components/ui/BodyPortal";
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
/** The editor's entrance and exit: its drawer spring, or with Reduce Motion a 150 ms cross-fade. */
export const editorTransition = (reduce: boolean) => (reduce ? { duration: 0.15 } : toMotion(SPRINGS.drawer));

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
  /** Saved, and whether LUME read it back exactly as written. */
  onSaved: (t: TemplateView, checked: boolean) => void;
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

  const form = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [askDiscard, setAskDiscard] = useState(false);
  // Unsaved: the words differ from the version last saved (or from nothing, for a new one).
  const was = {
    name: template?.name ?? "",
    category: template?.category ?? "first_touch",
    body: template?.body ?? "",
    roles: (template?.allowedRoleIds ?? []).join(),
  };
  const dirty =
    !readOnly &&
    (name !== was.name ||
      category !== was.category ||
      body !== was.body ||
      (onlyRoles ? roleIds : []).join() !== was.roles);
  /** Closing with unsaved words asks first; nothing is lost to a stray Esc or click (4A review). */
  const tryClose = () => (dirty ? setAskDiscard(true) : onClose());

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || suggest) return;
      if (askDiscard) return setAskDiscard(false);
      tryClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Focus goes in on open (the name, or the sheet when it can't be changed) and back where it was on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    (readOnly ? form.current : nameRef.current)?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  /** Tab stays inside the sheet, as a modal task's should. */
  const trap = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Tab" || !form.current) return;
    const items = [
      ...form.current.querySelectorAll<HTMLElement>(
        'input:not([disabled]), textarea, select, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

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
    if (!r.ok) {
      setBusy(false);
      return setProblem(r.message);
    }
    // Read it back: "saved" means LUME holds it exactly as written, not only that the request went through.
    const back = await templatesClient.list().catch(() => null);
    const stored = back?.ok ? back.data.templates.find((x) => x.id === r.data.id) : undefined;
    const checked =
      !!stored &&
      stored.version === r.data.version &&
      stored.name === input.name &&
      stored.body === input.body;
    setBusy(false);
    setSaved(`Saved as version ${r.data.version}`);
    onSaved(r.data, checked);
  };

  const count = body.length;
  return (
    <BodyPortal>
      <>
        <motion.div
          className={d.scrim}
          onClick={tryClose}
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        />
        <motion.form
          ref={form}
          tabIndex={-1}
          onKeyDown={trap}
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
          transition={editorTransition(!!reduce)}
        >
          <div className={d.top}>
            <IconButton label="Close (Esc)" onClick={tryClose}>
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
                ref={nameRef}
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
                  // A textbox may say it suggests and which suggestion is on; "expanded" is a combobox's word.
                  aria-autocomplete="list"
                  aria-controls={suggest ? `${bodyId}-vars` : undefined}
                  aria-activedescendant={suggest ? `${bodyId}-var${suggest.active}` : undefined}
                  onChange={(e) => {
                    setBody(e.target.value);
                    touched();
                    lookForBraces(e.target.value, e.target.selectionStart);
                  }}
                  onKeyDown={onBodyKey}
                  onBlur={() => setSuggest(null)}
                />
                {suggest && (
                  <ul id={`${bodyId}-vars`} role="listbox" aria-label="Variables" className={s.suggest}>
                    {suggest.options.map((v, i) => (
                      <li
                        key={v.token}
                        id={`${bodyId}-var${i}`}
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

          {askDiscard && (
            <div role="alertdialog" aria-label="Discard your changes?" className={`${s.foot} ${s.discard}`}>
              <p className={s.discardText}>Discard your changes?</p>
              <Button variant="ghost" autoFocus onClick={() => setAskDiscard(false)}>
                Keep editing
              </Button>
              <Button variant="danger" onClick={onClose}>
                Discard
              </Button>
            </div>
          )}
          {!readOnly && !askDiscard && (
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
    </BodyPortal>
  );
}

/** "Preview as": pick a real lead (names only); their preview context is fetched once. */
function PreviewAs({ onContext }: { onContext: (c: RenderContext | null) => void }) {
  const id = useId();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const asked = useRef(0);

  useEffect(() => {
    if (!q.trim() || picked === q) return setOptions([]);
    let live = true;
    const t = setTimeout(() => {
      void leadsClient.list({ q, stageIds: [], sort: "newest" }, undefined, 6).then((r) => {
        if (live && r.ok) {
          setOptions(r.data.items.map((l) => ({ id: l.id, name: l.name ?? "Unnamed lead" })));
          setActive(0);
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
    // Picks can answer out of order: only the latest one's words are shown.
    const mine = ++asked.current;
    const r = await templatesClient.context(l.id);
    if (mine === asked.current) onContext(r.ok ? r.data : null);
  };
  const shown = open && options.length > 0;
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!shown) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const l = options[active];
      if (l) void pick(l);
    } else if (e.key === "Escape") {
      e.preventDefault(); // closes the list, not the editor
      setOpen(false);
    }
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
        aria-expanded={shown}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={shown ? `${id}-o${active}` : undefined}
        className={s.input}
        placeholder="A sample lead · type a name"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPicked(null);
          if (!e.target.value.trim()) onContext(null);
        }}
        onKeyDown={onKey}
      />
      {open && options.length > 0 && (
        <ul id={`${id}-list`} role="listbox" aria-label="Leads" className={s.suggest}>
          {options.map((l, i) => (
            <li
              key={l.id}
              id={`${id}-o${i}`}
              role="option"
              aria-selected={i === active}
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
