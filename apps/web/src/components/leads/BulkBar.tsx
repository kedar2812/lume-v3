"use client";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { can, scopeOf } from "@lume/core/shared";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { bulkSummary, runBulkInChunks } from "@/lib/leads/bulk";
import type { BulkAction, BulkResult, Stage } from "@/lib/leads/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import type { Session } from "@/server/session";
import { useCatalog } from "./CatalogProvider";
import { LostReasonPicker } from "./LostReasonPicker";
import s from "./bulk.module.css";

const plural = (n: number) => `${n} ${n === 1 ? "lead" : "leads"}`;

/** Stages as a menu; Lost turns the menu into the lost-reason question for the whole selection. */
function StageMenu({ stages, count, run }: { stages: Stage[]; count: number; run: (a: BulkAction) => void }) {
  const [lost, setLost] = useState<Stage | null>(null);
  if (lost)
    return (
      <div className={s.lostPanel}>
        <p className={s.panelTitle}>Why were they lost?</p>
        <LostReasonPicker
          confirmLabel={`Mark ${count} as lost`}
          onCancel={() => setLost(null)}
          onConfirm={(lostReasonId, lostNote) =>
            run({ type: "stage", stageId: lost.id, lostReasonId, ...(lostNote ? { lostNote } : {}) })
          }
        />
      </div>
    );
  return (
    <ul className={s.menu}>
      {stages.map((st) => (
        <li key={st.id}>
          <button
            type="button"
            role="menuitem"
            onClick={() => (st.kind === "lost" ? setLost(st) : run({ type: "stage", stageId: st.id }))}
          >
            {st.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The bar that appears while leads are selected (spec §6): move, assign, tag or delete them together.
 * Each action goes in chunks the API accepts, and the result says what was skipped and why.
 */
export function BulkBar({
  session,
  selected,
  allLoaded = false,
  onDone,
  onClear,
}: {
  session: Session;
  selected: string[];
  /** The selection is every loaded row (the header checkbox), which may not be every match. */
  allLoaded?: boolean;
  onDone: (result: BulkResult) => void;
  onClear: () => void;
}) {
  const catalog = useCatalog();
  const { toast } = useToast();
  const reduce = useReducedMotion();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const n = selected.length;
  const actor = session.actor;
  const pipeline = catalog.pipelines.find((p) => p.isDefault) ?? catalog.pipelines[0];
  const stages = [...(pipeline?.stages ?? [])].sort((a, b) => a.position - b.position);
  const people = catalog.people.filter((p) => p.active);

  const run = async (action: BulkAction) => {
    setBusy(true);
    const result = await runBulkInChunks(selected, action);
    setBusy(false);
    setConfirmDelete(false);
    toast({ tone: result.skipped.length ? "warn" : "ok", title: bulkSummary(action, result) });
    onDone(result);
  };

  return (
    <motion.div
      role="toolbar"
      aria-label="Bulk actions"
      aria-busy={busy || undefined}
      className={s.bar}
      initial={{ opacity: 0, y: reduce ? 0 : 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: reduce ? 0 : 24 }}
      transition={toMotion(SPRINGS.default)}
    >
      {confirmDelete ? (
        <>
          <p className={s.confirm}>
            Delete {plural(n)}? <span>This can’t be undone from here.</span>
          </p>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" loading={busy} onClick={() => void run({ type: "delete" })}>
            Delete {plural(n)}
          </Button>
        </>
      ) : (
        <>
          <p className={s.count}>
            <span>{n} selected</span>
            {allLoaded && <span className={s.note}> · all loaded</span>}
          </p>
          <button type="button" className={s.clear} onClick={onClear}>
            Clear
          </button>
          <span className={s.divider} aria-hidden />
          {can(actor, "leads.change_stage") && (
            <Popover
              label="Move to stage"
              role="menu"
              triggerClassName={s.action}
              trigger="Move to stage"
              disabled={busy}
            >
              {(close) => (
                <StageMenu
                  stages={stages}
                  count={n}
                  run={(a) => {
                    close();
                    void run(a);
                  }}
                />
              )}
            </Popover>
          )}
          {can(actor, "leads.assign") && (
            <Popover
              label="Assign to"
              role="menu"
              triggerClassName={s.action}
              trigger="Assign"
              disabled={busy}
            >
              {(close) => (
                <ul className={s.menu}>
                  {people.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          close();
                          void run({ type: "assign", ownerId: p.id });
                        }}
                      >
                        {p.name}
                      </button>
                    </li>
                  ))}
                  {scopeOf(actor, "leads.assign") === "all" && (
                    <li>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          close();
                          void run({ type: "assign", ownerId: null });
                        }}
                      >
                        Unassigned
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </Popover>
          )}
          {catalog.tags.length > 0 && can(actor, "leads.edit") && (
            <Popover label="Tags" role="menu" triggerClassName={s.action} trigger="Tags" disabled={busy}>
              {(close) => (
                <div className={s.tagMenu}>
                  {(["add", "remove"] as const).map((op) => (
                    <div key={op} role="group" aria-label={op === "add" ? "Add a tag" : "Remove a tag"}>
                      <p className={s.groupTitle} aria-hidden>
                        {op === "add" ? "Add" : "Remove"}
                      </p>
                      <ul className={s.menu}>
                        {catalog.tags.map((t) => (
                          <li key={t.id}>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                close();
                                void run({ type: "tags", [op]: [t.id] });
                              }}
                            >
                              {op === "add" ? "Add" : "Remove"} {t.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </Popover>
          )}
          {can(actor, "leads.delete") && (
            <button type="button" className={s.danger} disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
        </>
      )}
    </motion.div>
  );
}
