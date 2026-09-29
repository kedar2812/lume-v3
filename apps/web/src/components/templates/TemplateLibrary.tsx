"use client";
import { AnimatePresence, Reorder, motion, useDragControls, useReducedMotion } from "motion/react";
import { useState, type KeyboardEvent } from "react";
import { TEMPLATE_CATEGORIES, type TemplateCategory } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { SPRINGS, toMotion } from "@/lib/motion";
import { templatesClient, type RoleName, type TemplateView } from "@/lib/templates/client";
import { TemplateEditor, type EditorField } from "./TemplateEditor";
import { TokenLine } from "./TokenLine";
import s from "./templates.module.css";

/** One opening of the editor: its key stays the same while it's open, so a save updates it in place. */
type Editing = { key: string; template?: TemplateView } | null;
const firstLine = (body: string) => body.split("\n").find((l) => l.trim()) ?? "";

/**
 * Templates (Phase 4A; frontend spec §8.9): the business's best wording, by kind. Managers add, edit,
 * reorder (drag the handle, or Alt+↑/↓) and archive (with undo); everyone else reads and previews.
 */
export function TemplateLibrary({
  initial,
  roles,
  fields,
  canManage,
}: {
  initial: TemplateView[];
  roles: RoleName[];
  fields: EditorField[];
  canManage: boolean;
}) {
  const reduce = useReducedMotion();
  const [templates, setTemplates] = useState(initial);
  const [editing, setEditing] = useState<Editing>(null);
  const [note, setNote] = useState<{ text: string; undo?: () => void } | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const groups = TEMPLATE_CATEGORIES.map((c) => ({
    ...c,
    items: templates.filter((t) => t.category === c.key),
  })).filter((g) => g.items.length);

  /** The whole order, group by group, as the server keeps it. */
  const saveOrder = async (next: TemplateView[]) => {
    const ids = TEMPLATE_CATEGORIES.flatMap((c) => next.filter((t) => t.category === c.key).map((t) => t.id));
    const r = await templatesClient.reorder(ids);
    if (!r.ok) setNote({ text: r.message || "The order couldn’t be saved." });
  };
  const regroup = (category: TemplateCategory, items: TemplateView[]) =>
    setTemplates((all) => [...all.filter((t) => t.category !== category), ...items]);

  const move = (t: TemplateView, step: -1 | 1) => {
    const group = templates.filter((x) => x.category === t.category);
    const at = group.findIndex((x) => x.id === t.id);
    const to = at + step;
    if (to < 0 || to >= group.length) return;
    const next = [...group];
    next.splice(at, 1);
    next.splice(to, 0, t);
    const all = [...templates.filter((x) => x.category !== t.category), ...next];
    setTemplates(all);
    void saveOrder(all);
  };

  const archive = async (t: TemplateView) => {
    const before = templates;
    setTemplates((all) => all.filter((x) => x.id !== t.id));
    const r = await templatesClient.archive(t.id);
    if (!r.ok) {
      setTemplates(before);
      return setNote({ text: r.message || "That template couldn’t be archived." });
    }
    setNote({
      text: `Archived “${t.name}”`,
      undo: async () => {
        const back = await templatesClient.restore(t.id);
        if (back.ok) setTemplates(before);
        else setNote({ text: back.message || "It couldn’t be put back." });
      },
    });
  };

  const saved = (t: TemplateView) => {
    setTemplates((all) =>
      all.some((x) => x.id === t.id) ? all.map((x) => (x.id === t.id ? t : x)) : [...all, t],
    );
    setFresh(`${t.id}:${t.version}`);
  };

  return (
    <div className={s.library}>
      <div className={s.toolbar}>
        <p className={s.lead}>
          {templates.length === 1 ? "1 template" : `${templates.length} templates`}
          {canManage ? ". Write once; everyone sends it in two taps." : ". Pick one when you message a lead."}
        </p>
        {canManage && (
          <Button variant="primary" onClick={() => setEditing({ key: crypto.randomUUID() })}>
            New template
          </Button>
        )}
      </div>

      {groups.length === 0 && (
        <div className={s.empty}>
          <img src="/lume-mark.png" alt="" width={48} height={48} />
          <p>{canManage ? "Write your first template" : "No templates for your role yet"}</p>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.key} className={s.group} aria-labelledby={`tpl-${g.key}`}>
          <h2 id={`tpl-${g.key}`} className={s.groupHead}>
            {g.label}
            <span>{g.items.length}</span>
          </h2>
          <Reorder.Group
            as="ul"
            axis="y"
            values={g.items}
            onReorder={(items) => regroup(g.key, items)}
            className={s.cards}
            aria-label={g.label}
          >
            <AnimatePresence initial={false}>
              {g.items.map((t) => (
                <Card
                  key={t.id}
                  t={t}
                  fields={fields}
                  who={
                    t.allowedRoleIds.length
                      ? t.allowedRoleIds.map((id) => roleName.get(id) ?? "A role").join(", ")
                      : "Everyone"
                  }
                  canManage={canManage}
                  fresh={fresh === `${t.id}:${t.version}` ? fresh : null}
                  reduce={!!reduce}
                  onOpen={() => setEditing({ key: t.id, template: t })}
                  onArchive={() => void archive(t)}
                  onMove={(step) => move(t, step)}
                  onDropped={() => void saveOrder(templates)}
                />
              ))}
            </AnimatePresence>
          </Reorder.Group>
        </section>
      ))}

      <AnimatePresence>
        {note && (
          <motion.p
            role="status"
            className={s.note}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={toMotion(SPRINGS.default)}
          >
            {note.text}
            {note.undo && (
              <button
                type="button"
                className={s.undo}
                onClick={() => {
                  const undo = note.undo!;
                  setNote(null);
                  undo();
                }}
              >
                Undo
              </button>
            )}
          </motion.p>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {editing && (
          <TemplateEditor
            key={editing.key}
            {...(editing.template ? { template: editing.template } : {})}
            roles={roles}
            fields={fields}
            readOnly={!canManage}
            onSaved={(t) => {
              saved(t);
              setEditing((e) => e && { ...e, template: t });
            }}
            onClose={() => setEditing(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function Card({
  t,
  who,
  canManage,
  fresh,
  fields,
  reduce,
  onOpen,
  onArchive,
  onMove,
  onDropped,
}: {
  t: TemplateView;
  who: string;
  fields: EditorField[];
  canManage: boolean;
  /** Set just after a save: the card glows once, so the eye finds what changed. */
  fresh: string | null;
  reduce: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onMove: (step: -1 | 1) => void;
  onDropped: () => void;
}) {
  const drag = useDragControls();
  const onHandleKey = (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    onMove(e.key === "ArrowUp" ? -1 : 1);
  };
  return (
    <Reorder.Item
      as="li"
      value={t}
      dragListener={false}
      dragControls={drag}
      onDragEnd={onDropped}
      className={s.card}
      data-fresh={fresh ? true : undefined}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
      // A reordered card always takes its new place; with Reduce Motion it goes there at once.
      transition={reduce ? { duration: 0 } : toMotion(SPRINGS.default)}
    >
      {canManage && (
        <button
          type="button"
          className={s.handle}
          aria-label={`Move ${t.name}`}
          title="Drag, or Alt + ↑ / ↓"
          onPointerDown={(e) => drag.start(e)}
          onKeyDown={onHandleKey}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            <path
              d="M4 3h.01M8 3h.01M4 6h.01M8 6h.01M4 9h.01M8 9h.01"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
      <button type="button" className={s.cardMain} onClick={onOpen}>
        <span className={s.cardName}>{t.name}</span>
        <span className={s.cardLine}>
          <TokenLine text={firstLine(t.body)} fields={fields} />
        </span>
        <span className={s.who}>{who}</span>
      </button>
      {canManage && (
        <Popover
          label={`More for ${t.name}`}
          role="menu"
          align="end"
          triggerClassName={s.more}
          trigger={
            <>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <path
                  d="M3.5 8h.01M8 8h.01M12.5 8h.01"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
              <span className={s.srOnly}>More for {t.name}</span>
            </>
          }
        >
          {(close) => (
            <div className={s.menu}>
              <button
                type="button"
                role="menuitem"
                className={s.menuItem}
                onClick={() => {
                  close();
                  onOpen();
                }}
              >
                Edit
              </button>
              <button
                type="button"
                role="menuitem"
                className={`${s.menuItem} ${s.danger}`}
                onClick={() => {
                  close();
                  onArchive();
                }}
              >
                Archive
              </button>
            </div>
          )}
        </Popover>
      )}
    </Reorder.Item>
  );
}
