"use client";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { importsClient } from "@/lib/imports/client";
import type { DraftView, ImportView } from "@/lib/imports/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import { ColumnsStep } from "./ColumnsStep";
import { FileStep } from "./FileStep";
import { PreviewStep } from "./PreviewStep";
import { ProgressStep } from "./ProgressStep";
import { RulesStep } from "./RulesStep";
import s from "./imports.module.css";

export type Step = "file" | "columns" | "rules" | "preview" | "run";
const STEPS: { id: Step; label: string }[] = [
  { id: "file", label: "File" },
  { id: "columns", label: "Columns" },
  { id: "rules", label: "Rules" },
  { id: "preview", label: "Preview" },
  { id: "run", label: "Import" },
];
/** Problems that belong to the Columns step; every other problem belongs to Rules. */
export const COLUMN_CODES = new Set([
  "FIELD_TWICE",
  "UNKNOWN_FIELD",
  "FIELD_NOT_EDITABLE",
  "SOURCE_NOT_MAPPABLE",
  "LAST_WITHOUT_FIRST",
  "NEW_FIELD_NOT_ALLOWED",
  "NEW_FIELD_LABEL_TAKEN",
  "NEW_FIELD_LABEL_TOO_LONG",
  "NEW_FIELD_TYPE",
  "NEW_OPTION_NOT_ALLOWED",
  "NEW_TAG_NOT_ALLOWED",
  "DATE_ORDER_NEEDED",
  "NO_NAME_COLUMN",
  "REQUIRED_FIELD_UNCOVERED",
]);
const FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Spec §9: importing leads from a CSV, as a sheet over the app. File → Columns → Rules → Preview →
 * Import; a step opens only once the ones before it have nothing blocking. A draft is kept (Settings →
 * Imports, 7 days) unless it's discarded, so closing half-way loses nothing.
 */
export function ImportSheet({
  open,
  draftId,
  importId,
  onClose,
}: {
  open: boolean;
  /** Reopen a kept draft at its Columns step. */
  draftId?: string;
  /** Open a started import: its progress while it runs, then its report. */
  importId?: string;
  onClose(): void;
}) {
  const reduce = useReducedMotion();
  const titleId = useId();
  const askId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [run, setRun] = useState<ImportView | null>(null);
  const [step, setStep] = useState<Step>("file");
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!open || !draftId) return;
    let live = true;
    void importsClient.draft(draftId).then((r) => {
      if (!live || !r.ok) return;
      setDraft(r.data);
      setStep("columns");
    });
    return () => {
      live = false;
    };
  }, [open, draftId]);

  useEffect(() => {
    if (!open || !importId) return;
    let live = true;
    void importsClient.get(importId).then((r) => {
      if (!live || !r.ok) return;
      setRun(r.data);
      setStep("run");
    });
    return () => {
      live = false;
    };
  }, [open, importId]);

  // Focus moves into the sheet when it opens and goes back where it was when it closes.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    sheet.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => before?.focus?.();
  }, [open]);

  const close = () => {
    if (draft && !run)
      setAsking(true); // a draft is kept unless it's discarded
    else onClose();
  };

  // Escape closes (or answers "keep for later?") wherever focus is. Popovers and pickers inside stop the
  // Escape they use before it gets here.
  const onEscape = useRef<() => void>(() => undefined);
  onEscape.current = () => (asking ? setAsking(false) : close());
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onEscape.current();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const columnsBlocked = !!draft?.problems.some((p) => COLUMN_CODES.has(p.code));
  const rulesBlocked = !!draft?.problems.some((p) => !COLUMN_CODES.has(p.code));
  const reachable = (id: Step): boolean => {
    if (run) return id === "run";
    if (id === "file") return true;
    if (!draft) return false;
    if (id === "columns") return true;
    if (id === "rules") return !columnsBlocked;
    if (id === "preview") return !columnsBlocked && !rulesBlocked;
    return false;
  };
  const order = STEPS.findIndex((x) => x.id === step);

  return createPortal(
    <div className={s.layer}>
      <motion.div
        className={s.scrim}
        aria-hidden
        onClick={close}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={toMotion(SPRINGS.soft)}
      />
      <motion.div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={s.sheet}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={toMotion(SPRINGS.default)}
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          const items = [...(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
          const first = items[0];
          const last = items.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }}
      >
        <aside className={s.rail}>
          <h2 id={titleId} className={s.title}>
            Import leads
          </h2>
          <nav aria-label="Import steps" className={s.steps}>
            <ol>
              {STEPS.map((x, i) => (
                <li key={x.id}>
                  <button
                    type="button"
                    className={s.step}
                    aria-current={step === x.id ? "step" : undefined}
                    data-done={(i < order && !run) || (run && x.id !== "run") || undefined}
                    disabled={!reachable(x.id)}
                    onClick={() => setStep(x.id)}
                  >
                    <span className={s.srOnly}>{i + 1} </span>
                    <span className={s.circle} aria-hidden>
                      {(i < order && !run) || (run && x.id !== "run") ? (
                        <svg viewBox="0 0 12 12" width="10" height="10">
                          <path
                            d="M2.5 6.2 5 8.5l4.5-5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        i + 1
                      )}
                    </span>
                    {x.label}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <p className={s.railFoot}>
            Nothing is imported until you press Start. LUME checks every row first.
          </p>
        </aside>
        <div className={s.pane}>
          <div className={s.close}>
            <IconButton label="Close (Esc)" onClick={close}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </IconButton>
          </div>
          {step === "file" && (
            <FileStep draft={draft} onDraft={setDraft} onContinue={() => setStep("columns")} />
          )}
          {step === "columns" && draft && (
            <ColumnsStep
              draft={draft}
              onDraft={setDraft}
              blocked={columnsBlocked}
              onContinue={() => setStep("rules")}
            />
          )}
          {step === "rules" && draft && (
            <RulesStep
              draft={draft}
              onDraft={setDraft}
              blocked={rulesBlocked}
              onContinue={() => setStep("preview")}
            />
          )}
          {step === "preview" && draft && (
            <PreviewStep
              draft={draft}
              onFix={(to) => setStep(to)}
              onStarted={(v) => {
                setRun(v);
                setStep("run");
              }}
            />
          )}
          {step === "run" && run && <ProgressStep initial={run} onClose={onClose} />}
        </div>
        {asking && draft && (
          <div className={s.veil}>
            <div role="alertdialog" aria-modal="true" aria-labelledby={askId} className={s.ask}>
              <h3 id={askId}>Keep this import for later?</h3>
              <p>LUME keeps it in Settings → Imports for 7 days, just as you left it.</p>
              <div className={s.askActions}>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await importsClient.discard(draft.id);
                    onClose();
                  }}
                >
                  Discard
                </Button>
                <Button variant="primary" autoFocus onClick={onClose}>
                  Keep for later
                </Button>
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </div>,
    document.body,
  );
}
