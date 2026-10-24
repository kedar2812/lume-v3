"use client";
import { AUTOPILOT_ACTION_TITLES, firstNameOf } from "@lume/core/shared";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/Button";
import type { RunAsk, RunLead } from "@/lib/autopilot/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./ready.module.css";

/** What a new card says as it arrives (§2): from its own headline, never invented. */
function arrival(l: RunLead): string {
  const who = firstNameOf(l.name) || l.name;
  const head = l.card?.headline ?? "";
  if (l.state === "ready" && /^Reached /.test(head))
    return `${who} reached ${head.slice(8)}. Want to take over?`;
  if (l.state === "ready") return `${who} is ready for you. Want to take over?`;
  return `${who} needs you${l.reason ? `: ${l.reason.replace(/\.$/, "")}` : ""}.`;
}

function Card({
  l,
  fresh,
  canDecide,
  onTakeOver,
  onCarryOn,
}: {
  l: RunLead;
  fresh: boolean;
  canDecide: boolean;
  onTakeOver(id: string): void;
  onCarryOn(id: string): void;
}) {
  const reduce = useReducedMotion();
  const deal =
    l.state === "needs_you" ? (l.reason ?? l.card?.headline ?? "Needs you") : (l.card?.headline ?? l.reason);
  return (
    <motion.article
      layout={reduce ? false : "position"}
      aria-label={l.name}
      className={s.card}
      data-tone={l.state === "ready" ? "ok" : "warn"}
      data-new={fresh || undefined}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      transition={toMotion(SPRINGS.default)}
    >
      <b className={s.name}>{l.name}</b>
      {deal && <p className={s.deal}>{deal}</p>}
      {l.card?.quote && <blockquote className={s.quote}>{l.card.quote}</blockquote>}
      <div className={s.actions}>
        <Button variant="primary" onClick={() => onTakeOver(l.leadId)}>
          Take over
        </Button>
        {canDecide && <Button onClick={() => onCarryOn(l.leadId)}>Let LUME AI carry on</Button>}
      </div>
    </motion.article>
  );
}

function AskItem({
  a,
  name,
  onApprove,
  onDecline,
}: {
  a: RunAsk;
  name: string;
  onApprove(id: string): Promise<unknown>;
  onDecline(id: string): Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const p = a.payload as { message?: string | null; fileIds?: string[] };
  const files = p.fileIds?.length ?? 0;
  const run = async (f: (id: string) => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await f(a.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={s.ask}>
      <div className={s.askHead}>
        <b>{AUTOPILOT_ACTION_TITLES[a.action]}</b>
        <span>{name}</span>
      </div>
      {p.message && <blockquote className={s.askMessage}>{p.message}</blockquote>}
      {files > 0 && <p className={s.askFiles}>With {files === 1 ? "a file" : `${files} files`} from Media</p>}
      <div className={s.actions}>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void run(onApprove)}>
          {p.message ? "Send it" : "Do it"}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void run(onDecline)}>
          Hand it to me
        </Button>
      </div>
    </li>
  );
}

/**
 * Ready for you (spec 2026-10-19 §2): leads that reached the goal (Converted) and leads that need a person (Needs you),
 * each counted; each card with the deal in one line, the lead's own words and two ways on: Take over, or let LUME AI
 * carry on. A card that arrives while someone's watching rings once and LUME says so. "Ask me" items (§2.1) wait above
 * them: what LUME AI wants to do, in words, done in one tap.
 */
export function ReadyColumn({
  leads,
  asks,
  canDecide,
  onTakeOver,
  onCarryOn,
  onApprove,
  onDecline,
}: {
  leads: RunLead[];
  asks: RunAsk[];
  canDecide: boolean;
  onTakeOver(leadId: string): void;
  onCarryOn(leadId: string): void;
  onApprove(askId: string): Promise<unknown>;
  onDecline(askId: string): Promise<unknown>;
}) {
  const { toast } = useToast();
  const converted = leads.filter((l) => l.state === "ready");
  const needs = leads.filter((l) => l.state === "needs_you");
  const total = converted.length + needs.length;
  // The cards there when the page opened aren't news; one that arrives after is.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const here = [...converted, ...needs];
  const key = here.map((l) => l.leadId).join(",");
  const latest = useRef({ here, toast, onTakeOver });
  latest.current = { here, toast, onTakeOver };
  useEffect(() => {
    const { here: now, toast: say, onTakeOver: take } = latest.current;
    if (!seen.current) {
      seen.current = new Set(now.map((l) => l.leadId));
      return;
    }
    const arrived = now.filter((l) => !seen.current!.has(l.leadId));
    for (const l of arrived) {
      seen.current.add(l.leadId);
      say({
        tone: l.state === "ready" ? "ok" : "warn",
        title: arrival(l),
        action: { label: "Take over", onClick: () => take(l.leadId) },
        // A lead reaching the goal is an achievement: the one moment LUME makes a sound here.
        ...(l.state === "ready" ? { sound: "won" as const } : {}),
      });
    }
    if (arrived.length) setFresh((f) => new Set([...f, ...arrived.map((x) => x.leadId)]));
  }, [key]);

  const nameOf = (id: string) => leads.find((l) => l.leadId === id)?.name ?? "A lead";
  const group = (label: string, list: RunLead[]) =>
    list.length > 0 && (
      <div role="group" aria-label={`${label}, ${list.length}`} className={s.group}>
        <p className={s.groupName} aria-hidden>
          {label} <span>{list.length}</span>
        </p>
        <AnimatePresence initial={false}>
          {list.map((l) => (
            <Card
              key={l.leadId}
              l={l}
              fresh={fresh.has(l.leadId)}
              canDecide={canDecide}
              onTakeOver={onTakeOver}
              onCarryOn={onCarryOn}
            />
          ))}
        </AnimatePresence>
      </div>
    );

  return (
    <aside className={s.col}>
      {asks.length > 0 && (
        <section
          id="autopilot-asks"
          tabIndex={-1}
          className={s.asks}
          aria-label={`Waiting for you, ${asks.length}`}
        >
          <h2 className={s.asksTitle}>Waiting for you</h2>
          <ul>
            {asks.map((a) => (
              <AskItem key={a.id} a={a} name={nameOf(a.leadId)} onApprove={onApprove} onDecline={onDecline} />
            ))}
          </ul>
        </section>
      )}
      <h2 className={s.title} aria-label={`Ready for you, ${total}`}>
        Ready for you {total > 0 && <span className={s.badge}>{total}</span>}
      </h2>
      {total === 0 ? (
        <p className={s.empty}>When a lead reaches the goal, or needs a person, LUME AI brings them here.</p>
      ) : (
        <>
          {group("Converted", converted)}
          {group("Needs you", needs)}
        </>
      )}
    </aside>
  );
}
