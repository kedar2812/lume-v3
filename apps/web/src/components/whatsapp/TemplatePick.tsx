"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { WhatsAppIcon } from "@/components/ui/WhatsAppIcon";
import { aboutCost } from "@/lib/whatsapp/cost";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaTemplateOption, WaTemplateState, WaThreadMessage } from "@/lib/whatsapp/types";
import s from "./TemplatePick.module.css";

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const costLine = (o: WaTemplateOption) =>
  o.cost ? `WhatsApp charges ${aboutCost(o.cost)} for this.` : "WhatsApp charges for this.";

/**
 * Outside WhatsApp's 24 hours, or for a lead who never wrote (plan W3b-2 Task 7): the business's approved templates
 * in this lead's words, what each costs, and Send. One whose values the lead doesn't have says which, and can't be
 * chosen. Nothing approved: nothing here, and the reply box shows its reason as before.
 */
export function TemplatePick({
  leadId,
  leadName,
  onSent,
}: {
  leadId: string;
  leadName: string;
  onSent(m: WaThreadMessage): void;
}) {
  const [state, setState] = useState<WaTemplateState | undefined>(undefined);
  const [chosen, setChosen] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  if (!state || !state.number || !state.options.length) return null;
  const options = state.options;
  const ready = (o: WaTemplateOption) => o.missing.length === 0;
  const pick = (o: WaTemplateOption) => {
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
  const onKey = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    for (let j = i + step; j >= 0 && j < options.length; j += step)
      if (ready(options[j]!)) {
        pick(options[j]!);
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
              onClick={() => pick(o)}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  pick(o);
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
      {error && (
        <div role="alert" className={s.error}>
          {error}
        </div>
      )}
      <div className={s.foot}>
        <Button
          variant="whatsapp"
          size="sm"
          disabled={!chosen || sending}
          loading={sending}
          onClick={() => void send()}
        >
          Send template
        </Button>
        <span className={s.from}>
          From {state.number.display} · or wait for {who}&apos;s reply
        </span>
      </div>
    </section>
  );
}
