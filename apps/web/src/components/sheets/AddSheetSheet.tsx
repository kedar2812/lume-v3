"use client";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ColumnsStep } from "@/components/imports/ColumnsStep";
import { COLUMN_CODES } from "@/components/imports/ImportSheet";
import { PreviewStep } from "@/components/imports/PreviewStep";
import { RulesStep } from "@/components/imports/RulesStep";
import s from "@/components/imports/imports.module.css";
import k from "./sheets.module.css";
import { IconButton } from "@/components/ui/IconButton";
import { importsClient } from "@/lib/imports/client";
import type { DraftView } from "@/lib/imports/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import { sheetsClient } from "@/lib/sheets/client";
import type { SheetDraft } from "@/lib/sheets/types";
import { SheetStep } from "./SheetStep";
import { StartFromStep } from "./StartFromStep";

type Step = "sheet" | "columns" | "rules" | "preview" | "start";
const FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Spec §7.2: connecting a sheet, in the Import sheet's own frame. Sheet → Columns → Rules → Preview → Start.
 * Columns, Rules and Preview are the 2A steps on a draft of the sheet (amendment A1). With `sourceId` it
 * edits that sheet's columns and rules. A sheet draft isn't kept: closing throws it away.
 */
export function AddSheetSheet({
  open,
  sourceId,
  onClose,
}: {
  open: boolean;
  sourceId?: string;
  onClose(savedId?: string): void;
}) {
  const reduce = useReducedMotion();
  const titleId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>("sheet");
  const [made, setMade] = useState<SheetDraft | null>(null);
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = !!sourceId;
  const steps: { id: Step; label: string }[] = [
    ...(editing ? [] : [{ id: "sheet" as const, label: "Sheet" }]),
    { id: "columns", label: "Columns" },
    { id: "rules", label: "Rules" },
    { id: "preview", label: "Preview" },
    { id: "start", label: editing ? "Save" : "Start" },
  ];

  useEffect(() => {
    if (!open) {
      setStep("sheet");
      setMade(null);
      setDraft(null);
      setError(null);
      return;
    }
    if (!sourceId) return;
    let live = true;
    setBusy(true);
    void sheetsClient.draft({ sourceId }).then((r) => {
      if (!live) return;
      setBusy(false);
      if (!r.ok) return setError(r.message);
      setMade(r.data);
      setDraft(r.data.draft);
      setStep("columns");
    });
    return () => {
      live = false;
    };
  }, [open, sourceId]);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    sheet.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => before?.focus?.();
  }, [open]);

  const close = (savedId?: string) => {
    if (draft && !savedId) void importsClient.discard(draft.id);
    onClose(savedId);
  };
  const onEscape = useRef<() => void>(() => undefined);
  onEscape.current = () => close();
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

  const choose = async (o: { link: string; sheetId: number }) => {
    setBusy(true);
    setError(null);
    if (draft) void importsClient.discard(draft.id); // a different tab: the old draft goes
    const r = await sheetsClient.draft(o);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setMade(r.data);
    setDraft(r.data.draft);
    setStep("columns");
  };
  const save = async (o: { name: string; pollSeconds: number; startFrom: "all" | "new" }) => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const r = await sheetsClient.save({ importId: draft.id, ...o });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    onClose(r.data.id);
  };

  const columnsBlocked = !!draft?.problems.some((p) => COLUMN_CODES.has(p.code));
  const rulesBlocked = !!draft?.problems.some((p) => !COLUMN_CODES.has(p.code));
  const reachable = (id: Step) =>
    id === "sheet" ||
    (!!draft &&
      (id === "columns" ||
        (id === "rules" && !columnsBlocked) ||
        ((id === "preview" || id === "start") && !columnsBlocked && !rulesBlocked)));
  const order = steps.findIndex((x) => x.id === step);
  const hasDate = !!draft?.mapping.columns.some((c) => c.to === "field" && c.field === "lead_created_at");

  return createPortal(
    <div className={s.layer}>
      <motion.div
        className={s.scrim}
        aria-hidden
        onClick={() => close()}
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
          if (e.shiftKey && document.activeElement === items[0]) {
            e.preventDefault();
            items.at(-1)?.focus();
          } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
            e.preventDefault();
            items[0]?.focus();
          }
        }}
      >
        <aside className={s.rail}>
          <h2 id={titleId} className={s.title}>
            {editing ? "Sheet columns" : "Add a sheet"}
          </h2>
          <nav aria-label="Steps" className={s.steps}>
            <ol>
              {steps.map((x, i) => (
                <li key={x.id}>
                  <button
                    type="button"
                    className={s.step}
                    aria-current={step === x.id ? "step" : undefined}
                    data-done={i < order || undefined}
                    disabled={!reachable(x.id)}
                    onClick={() => setStep(x.id)}
                  >
                    <span className={s.srOnly}>{i + 1} </span>
                    <span className={s.circle} aria-hidden>
                      {i + 1}
                    </span>
                    {x.label}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <p className={s.railFoot}>
            Nothing comes in until you connect the sheet. LUME checks every row first.
          </p>
        </aside>
        <div className={s.pane}>
          <div className={s.close}>
            <IconButton label="Close (Esc)" onClick={() => close()}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </IconButton>
          </div>
          {error && step !== "start" && (
            <p role="alert" className={`${s.note} ${s.problem}`}>
              {error}
            </p>
          )}
          {step === "sheet" && <SheetStep busy={busy} onChoose={(o) => void choose(o)} />}
          {step === "columns" && draft && (
            <ColumnsStep
              draft={draft}
              onDraft={setDraft}
              blocked={columnsBlocked}
              onContinue={() => setStep("rules")}
              notice={
                hasDate ? undefined : (
                  <p className={k.hint} role="note">
                    Map the column with each enquiry's date and time. Without it, LUME can't tell a repeat
                    enquiry from the same row.
                  </p>
                )
              }
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
              onFix={(to) => setStep(to as Step)}
              onContinue={() => setStep("start")}
            />
          )}
          {step === "start" && draft && made && (
            <StartFromStep
              defaultName={made.sheet.name}
              defaultPoll={made.sheet.pollSeconds}
              rowCount={draft.rowCount}
              moreRows={made.sheet.moreRows}
              editing={editing}
              saving={busy}
              error={error}
              onSave={(o) => void save(o)}
            />
          )}
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
