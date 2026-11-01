"use client";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { Button } from "@/components/ui/Button";
import { WhatsAppIcon } from "@/components/ui/WhatsAppIcon";
import { aboutCost } from "@/lib/whatsapp/cost";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaTemplateOption, WaTemplateState, WaThreadMessage } from "@/lib/whatsapp/types";
import s from "./TemplatePick.module.css";

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const costLine = (o: WaTemplateOption) =>
  o.cost ? `WhatsApp charges ${aboutCost(o.cost)} for this.` : "WhatsApp charges for this.";

type Pick = { submissionId: string; why: string };
/** LUME AI's pick, once per lead and set of templates in a session: opening the lead again asks nothing new. */
const picks = new Map<string, Promise<Pick | null>>();
/** For tests: each starts with nothing remembered. */
export const forgetTemplatePicks = () => picks.clear();
const dismissKey = (leadId: string) => `lume.templatePick.dismissed.${leadId}`;
const dismissedFor = (leadId: string) => {
  try {
    return sessionStorage.getItem(dismissKey(leadId)) === "1";
  } catch {
    return false;
  }
};

/**
 * Outside WhatsApp's 24 hours, or for a lead who never wrote (plan W3b-2 Task 7): the business's approved templates
 * in this lead's words, what each costs, and Send. One whose values the lead doesn't have says which, and can't be
 * chosen. Nothing approved: nothing here, and the reply box shows its reason as before.
 *
 * With LUME AI on (owner, 2026-10-31): LUME AI's pick first, Recommended by LUME AI with why in one line, and the rest
 * a tap away. A recommendation, so it goes in one tap too: Dismiss folds it to "Send a template" for this lead.
 */
export function TemplatePick({
  leadId,
  leadName,
  ai = false,
  onSent,
}: {
  leadId: string;
  leadName: string;
  /** Ask LUME AI for its pick (LUME AI on here). */
  ai?: boolean;
  onSent(m: WaThreadMessage): void;
}) {
  const [state, setState] = useState<WaTemplateState | undefined>(undefined);
  const [chosen, setChosen] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => dismissedFor(leadId));
  // undefined: LUME AI is choosing; null: no pick.
  const [pick, setPick] = useState<Pick | null | undefined>(undefined);
  const [view, setView] = useState<"pick" | "list">("pick");
  // Dismissed: folded to one button until it's opened again.
  const [openList, setOpenList] = useState(false);
  const key = useRef(crypto.randomUUID());
  const busy = useRef(false);
  const id = useId();
  const who = first(leadName);

  useEffect(() => {
    let live = true;
    void whatsappClient.templateState(leadId).then((r) => {
      if (live) setState(r.ok ? r.data : null);
    });
    return () => {
      live = false;
    };
  }, [leadId]);

  const readyIds = state?.number
    ? state.options.filter((o) => o.missing.length === 0).map((o) => o.submissionId)
    : [];
  const asks = ai && !dismissed && readyIds.length > 0;
  const askKey = `${leadId}:${readyIds.join(",")}`;
  useEffect(() => {
    if (!asks) return;
    let live = true;
    if (!picks.has(askKey))
      picks.set(
        askKey,
        whatsappClient.recommendTemplate(leadId).then((r) => (r.ok ? r.data.pick : null)),
      );
    void picks.get(askKey)!.then((p) => {
      if (!live) return;
      setPick(p);
      if (p) setChosen(p.submissionId);
    });
    return () => {
      live = false;
    };
  }, [asks, askKey, leadId]);

  if (!state || !state.number || !state.options.length) return null;
  const options = state.options;
  const ready = (o: WaTemplateOption) => o.missing.length === 0;
  const choose = (o: WaTemplateOption) => {
    if (!ready(o)) return;
    setChosen(o.submissionId);
    setError(null);
    // A different template is a different message.
    key.current = crypto.randomUUID();
  };
  const send = async () => {
    if (busy.current || !chosen) return;
    busy.current = true;
    setSending(true);
    setError(null);
    const r = await whatsappClient.sendTemplate(leadId, { submissionId: chosen, clientKey: key.current });
    busy.current = false;
    setSending(false);
    // Not taken: the choice stays, and so does the key, so trying again is the same message.
    if (!r.ok) return setError(r.message);
    key.current = crypto.randomUUID();
    setChosen(null);
    onSent(r.data.message);
  };
  const dismiss = () => {
    try {
      sessionStorage.setItem(dismissKey(leadId), "1");
    } catch {
      // A private window: dismissed for now, not remembered.
    }
    setDismissed(true);
    setView("list");
    setChosen(null);
    setOpenList(false);
  };
  const foot = (
    <>
      {error && (
        <div role="alert" className={s.error}>
          {error}
        </div>
      )}
      <span className={s.from}>
        From {state.number.display} · or wait for {who}&apos;s reply
      </span>
    </>
  );
  const sendButton = (
    <Button
      variant="whatsapp"
      size="sm"
      disabled={!chosen || sending}
      loading={sending}
      onClick={() => void send()}
    >
      Send template
    </Button>
  );

  // LUME AI's pick: choosing, then the pick with why.
  const recommended = pick ? options.find((o) => o.submissionId === pick.submissionId) : undefined;
  if (asks && view === "pick" && (pick === undefined || recommended)) {
    const title = `${id}-rec`;
    return (
      <section className={s.rec} aria-labelledby={title} aria-busy={pick === undefined || undefined}>
        <div className={s.recHead}>
          <AiGlyph size={18} draw="loop" />
          <h3 id={title} className={s.recTitle}>
            Recommended by LUME AI
          </h3>
          <button type="button" className={s.dismiss} onClick={dismiss}>
            <X size={14} aria-hidden />
            <span>Dismiss</span>
          </button>
        </div>
        {pick === undefined || !recommended ? (
          <>
            <p className={s.choosing}>LUME AI is choosing a template for {who}…</p>
            <div className={s.ghost} aria-hidden>
              <span />
              <span />
              <span />
            </div>
          </>
        ) : (
          <>
            <article className={s.card}>
              <span className={s.name}>{recommended.name}</span>
              <span className={s.cardText}>{recommended.preview}</span>
              <span className={s.cost}>{costLine(recommended)}</span>
            </article>
            {pick?.why && (
              <p className={s.why}>
                <span className={s.whyLabel}>Why this one:</span> {pick?.why}
              </p>
            )}
            <div className={s.foot}>
              {sendButton}
              {options.length > 1 && (
                <button type="button" className={s.quiet} onClick={() => setView("list")}>
                  Other templates
                </button>
              )}
            </div>
            {foot}
          </>
        )}
      </section>
    );
  }

  // Dismissed: one quiet way back to the templates.
  if (dismissed && !openList) return <FoldedPick onOpen={() => setOpenList(true)} />;

  const onKey = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    for (let j = i + step; j >= 0 && j < options.length; j += step)
      if (ready(options[j]!)) {
        choose(options[j]!);
        document.getElementById(`${id}-${j}`)?.focus();
        return;
      }
  };

  return (
    <section className={s.pick} aria-labelledby={`${id}-title`}>
      <div className={s.head}>
        <WhatsAppIcon size={16} />
        <h3 id={`${id}-title`} className={s.title}>
          Send an approved template
        </h3>
        {asks && recommended && (
          <button type="button" className={s.back} onClick={() => setView("pick")}>
            Back to LUME AI&apos;s pick
          </button>
        )}
      </div>
      <div role="radiogroup" aria-labelledby={`${id}-title`} className={s.list}>
        {options.map((o, i) => {
          const on = chosen === o.submissionId;
          const blocked = !ready(o);
          const tabbable = on || (!chosen && i === options.findIndex(ready));
          return (
            <div
              key={o.submissionId}
              id={`${id}-${i}`}
              role="radio"
              aria-checked={on}
              aria-disabled={blocked || undefined}
              tabIndex={tabbable ? 0 : -1}
              className={s.option}
              data-on={on || undefined}
              onClick={() => choose(o)}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  choose(o);
                } else onKey(e, i);
              }}
            >
              <span className={s.dot} aria-hidden />
              <span className={s.body}>
                <span className={s.name}>{o.name}</span>
                <span className={s.preview}>{o.preview}</span>
                <span className={blocked ? s.needs : s.cost}>
                  {blocked ? `Needs ${o.missing.join(", ")} first` : costLine(o)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <div className={s.foot}>{sendButton}</div>
      {foot}
    </section>
  );
}

function FoldedPick({ onOpen }: { onOpen(): void }) {
  return (
    <button type="button" className={s.folded} onClick={onOpen}>
      <WhatsAppIcon size={16} />
      <span>Send a template</span>
    </button>
  );
}
