"use client";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ColumnsStep } from "@/components/imports/ColumnsStep";
import { COLUMN_CODES } from "@/components/imports/ImportSheet";
import { PreviewStep } from "@/components/imports/PreviewStep";
import { RulesStep } from "@/components/imports/RulesStep";
import s from "@/components/imports/imports.module.css";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { importsClient } from "@/lib/imports/client";
import type { DraftView } from "@/lib/imports/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import { webhooksClient } from "@/lib/webhooks/client";
import type { WebhookCreated, WebhookPreset } from "@/lib/webhooks/types";
import { SecretStep } from "./SecretStep";
import { TestStep } from "./TestStep";
import { WhereFromStep } from "./WhereFromStep";
import w from "./webhooks.module.css";

type Step = "from" | "secret" | "test" | "columns" | "rules" | "preview" | "save";
const FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Spec §6: setting up a webhook, in the Import sheet's own frame. Where from → Address and secret → Send a
 * test → Columns → Rules → Preview → Save. The test post's paths are the columns of the 2A steps. With
 * `sourceId`, it finishes one still being set up (from the test) or edits a live one (from Columns).
 */
export function AddWebhookSheet({
  open,
  manychat,
  sourceId,
  finishing = false,
  onClose,
}: {
  open: boolean;
  /** This server offers the ManyChat preset (LUME_MANYCHAT_PRESET=on). */
  manychat: boolean;
  sourceId?: string;
  /** The webhook is still being set up: carry on from its test post. */
  finishing?: boolean;
  onClose(savedId?: string): void;
}) {
  const reduce = useReducedMotion();
  const titleId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const editing = !!sourceId && !finishing;
  // Where it opens: a new webhook at "Where from", one being set up at its test, an edit at Columns.
  const first: Step = !sourceId ? "from" : finishing ? "test" : "columns";
  const [step, setStep] = useState<Step>(first);
  const [made, setMade] = useState<WebhookCreated | null>(null);
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [keepTest, setKeepTest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = made?.source.id ?? sourceId ?? null;
  const steps: { id: Step; label: string }[] = [
    ...(sourceId
      ? []
      : [
          { id: "from" as const, label: "Where from" },
          { id: "secret" as const, label: "Address and secret" },
        ]),
    ...(editing ? [] : [{ id: "test" as const, label: "Send a test" }]),
    { id: "columns", label: "Columns" },
    { id: "rules", label: "Rules" },
    { id: "preview", label: "Preview" },
    { id: "save", label: "Save" },
  ];

  useEffect(() => {
    if (!open) {
      setStep(first);
      setMade(null);
      setDraft(null);
      setKeepTest(true);
      setError(null);
      return;
    }
    if (!sourceId || finishing) return;
    let live = true;
    setBusy(true);
    void webhooksClient.draft(sourceId).then((r) => {
      if (!live) return;
      setBusy(false);
      if (!r.ok) return setError(r.message);
      setDraft(r.data);
      setStep("columns");
    });
    return () => {
      live = false;
    };
  }, [open, sourceId, finishing, first]);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    sheet.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => before?.focus?.();
  }, [open]);

  // Closing throws the draft away (only the draft: the webhook stays, listed as being set up).
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

  const create = async (o: { preset: WebhookPreset; name: string }) => {
    setBusy(true);
    setError(null);
    const r = await webhooksClient.create(o);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setMade(r.data);
    setStep("secret");
  };
  const takeTest = async () => {
    if (!id) return;
    setBusy(true);
    setError(null);
    if (draft) void importsClient.discard(draft.id); // a newer post: the old draft goes
    const r = await webhooksClient.draft(id);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setDraft(r.data);
    setStep("columns");
  };
  const save = async () => {
    if (!draft || !id) return;
    setBusy(true);
    setError(null);
    const r = await webhooksClient.save(id, { importId: draft.id, keepTest: !editing && keepTest });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    onClose(r.data.id);
  };

  const columnsBlocked = !!draft?.problems.some((p) => COLUMN_CODES.has(p.code));
  const rulesBlocked = !!draft?.problems.some((p) => !COLUMN_CODES.has(p.code));
  // Once created, there's no going back to "Where from": the webhook exists, and its secret was shown.
  const reachable = (x: Step) =>
    x === "from"
      ? !made && !sourceId
      : x === "secret"
        ? !!made
        : x === "test"
          ? !!id
          : !!draft &&
            (x === "columns" ||
              (x === "rules" && !columnsBlocked) ||
              ((x === "preview" || x === "save") && !columnsBlocked && !rulesBlocked));
  const order = steps.findIndex((x) => x.id === step);

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
            {editing ? "Webhook fields" : finishing ? "Finish setting up" : "Add a webhook"}
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
          <p className={s.railFoot}>Nothing comes in until you turn it on. LUME checks every post first.</p>
        </aside>
        <div className={s.pane}>
          <div className={s.close}>
            <IconButton label="Close (Esc)" onClick={() => close()}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </IconButton>
          </div>
          {error && step !== "save" && (
            <p role="alert" className={`${s.note} ${s.problem}`}>
              {error}
            </p>
          )}
          {step === "from" && (
            <WhereFromStep manychat={manychat} busy={busy} onCreate={(o) => void create(o)} />
          )}
          {step === "secret" && made && (
            <SecretStep
              preset={made.source.preset}
              mode={made.mode}
              address={made.address}
              secret={made.secret}
              onContinue={() => setStep("test")}
            />
          )}
          {step === "test" && id && <TestStep id={id} busy={busy} onUse={() => void takeTest()} />}
          {step === "columns" && !draft && !error && (
            <section className={s.body} aria-busy="true">
              <p className={s.lede}>Reading this webhook's fields…</p>
            </section>
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
              onFix={(to) => setStep(to as Step)}
              onContinue={() => setStep("save")}
            />
          )}
          {step === "save" && draft && (
            <>
              <section className={s.body}>
                <h3 className={s.stepTitle}>{editing ? "Save changes" : "Turn it on"}</h3>
                <p className={s.lede}>
                  {editing
                    ? "New posts use these fields and rules from now on."
                    : "From now on, every post to this address becomes a lead, usually within a second."}
                </p>
                {!editing && (
                  <div className={w.keep}>
                    <input
                      id={`${titleId}-keep`}
                      type="checkbox"
                      checked={keepTest}
                      aria-describedby={`${titleId}-keep-hint`}
                      onChange={(e) => setKeepTest(e.target.checked)}
                    />
                    <span>
                      <label htmlFor={`${titleId}-keep`}>Keep the test post as a lead</label>
                      <small id={`${titleId}-keep-hint`}>Clear this if it was made up.</small>
                    </span>
                  </div>
                )}
                {error && (
                  <p role="alert" className={`${s.note} ${s.problem}`}>
                    {error}
                  </p>
                )}
              </section>
              <footer className={s.foot}>
                <p className={s.footNote}>You can pause it or change its fields any time.</p>
                <Button variant="primary" loading={busy} onClick={() => void save()}>
                  {editing ? "Save changes" : "Turn it on"}
                </Button>
              </footer>
            </>
          )}
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
