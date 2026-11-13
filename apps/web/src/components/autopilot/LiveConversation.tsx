"use client";
import { AUTOPILOT_ACTION_TITLES, firstNameOf } from "@lume/core/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { useToast } from "@/components/feedback/ToastProvider";
import { WhatsAppComposer } from "@/components/leads/drawer/WhatsAppComposer";
import { WhatsAppThread } from "@/components/leads/drawer/WhatsAppThread";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { Skeleton } from "@/components/ui/Skeleton";
import type { RunAsk, RunLead } from "@/lib/autopilot/types";
import { leadsClient } from "@/lib/leads/client";
import { leadLine, whenWords } from "@/lib/autopilot/words";
import { useAutopilot, useWhatsApp } from "@/lib/notifications/stream";
import { useChatOnScreen } from "@/lib/whatsapp/open-chats";
import { useStickToBottom } from "@/lib/ui/use-stick-to-bottom";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaThread } from "@/lib/whatsapp/types";
import { TypingComposer } from "./TypingComposer";
import s from "./live.module.css";

/** LUME AI is still working these: a person may take one over (§2.1). */
const WORKING = ["up_next", "writing", "sent", "replied", "talking"];

/**
 * The conversation pane of the LUME AI page (plan 2026-10-28, artboards 1-2): the lead's name and what's happening in
 * one line, the lead itself one click away, and Take over while LUME AI works; the WhatsApp thread with LUME AI typing;
 * its "Why" in one quiet line at the foot. Where a person is needed, one bar sits where the reply box would be: an ask
 * (what LUME AI prepared, sent in one tap, or the lead is yours), a lead that needs you (why, and Reply yourself), or a
 * lead ready for you (the headline, and Take over). A lead taken over gets its own reply box, from LUME AI's half-typed
 * words, and Hand back. Once the run has ended the lead is simply the person's to message. Someone who may not message
 * the lead watches only.
 */
export function LiveConversation({
  lead,
  tz,
  speaker,
  frozenAt,
  takenOverText,
  onTakeOver,
  onHandBack,
  ended,
  canDecide,
  onCarryOn,
  ask,
  onApprove,
  onDecline,
  canLiftDnc = false,
}: {
  /** An admin (settings.manage): may lift a lead's do not contact here, beside Open lead (owner 2026-11-04). */
  canLiftDnc?: boolean;
  lead: RunLead;
  tz: string;
  speaker: string;
  /** The run was paused at this moment: the typing stops where it was. */
  frozenAt: Date | null;
  /** LUME AI's half-typed words, handed over with the lead. */
  takenOverText: string | null;
  onTakeOver(): void;
  onHandBack(): void;
  /** The run has ended: LUME AI does nothing more in it. */
  ended: boolean;
  /** May let LUME AI carry on with a lead that needs or is ready for a person (the run's controllers). */
  canDecide: boolean;
  onCarryOn(): void;
  /** What LUME AI asked about for this lead (Ask me), waiting for a tap. */
  ask: RunAsk | null;
  onApprove(askId: string): unknown;
  onDecline(askId: string): unknown;
}) {
  const who = firstNameOf(lead.name) || lead.name;
  const [thread, setThread] = useState<WaThread | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = useRef(lead.leadId);
  shown.current = lead.leadId;

  const read = useCallback(() => {
    const want = shown.current;
    void whatsappClient.thread(want).then((r) => {
      if (shown.current !== want) return;
      if (r.ok) {
        setThread(r.data);
        setProblem(null);
      } else setProblem(r.message);
    });
  }, []);
  useEffect(() => {
    setThread(null);
    read();
  }, [lead.leadId, read]);
  // A message sent, a reply, a take-over: this lead's thread is read again.
  useAutopilot((e) => {
    if (e.lead === shown.current || e.run === "*") read();
  });
  // Any WhatsApp message on this chat too (2026-11-01): a lead that's ready for a person writes again, a person replies.
  useWhatsApp((e) => {
    if (e.lead === shown.current || e.lead === "*") read();
  });
  useChatOnScreen(lead.leadId);
  const { toast } = useToast();

  // A stopped lead who asked not to be messaged: an admin may lift it from here, as on the lead (owner 2026-11-04).
  const isStopped = lead.state === "stopped";
  const [dnc, setDnc] = useState(false);
  useEffect(() => {
    setDnc(false);
    if (!isStopped || !canLiftDnc) return;
    let live = true;
    void leadsClient.get(lead.leadId).then((r) => {
      if (live && r.ok) setDnc(!!r.data.lead.doNotContact);
    });
    return () => {
      live = false;
    };
  }, [isStopped, canLiftDnc, lead.leadId]);

  // The newest message stays in view as messages arrive and LUME AI types, unless someone scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null);
  useStickToBottom(scroller, `${thread?.messages.length ?? 0}:${lead.state}`);

  const mayMessage = !!thread?.reply;
  const working = !ended && WORKING.includes(lead.state);

  const [deciding, setDeciding] = useState(false);
  const decide = async (f: (id: string) => unknown, id: string) => {
    if (deciding) return;
    setDeciding(true);
    try {
      await f(id);
    } finally {
      setDeciding(false);
    }
  };
  const line = leadLine(lead, ask, (iso) => whenWords(iso, tz, new Date())).text;
  const stopped = lead.state === "stopped";

  // Where the reply box would be: the person's own box, LUME AI typing, or the one thing a person needs to do.
  let composer = null;
  if (ended && thread?.reply)
    composer = (
      <div className={s.mine}>
        <WhatsAppComposer
          key={lead.leadId}
          leadId={lead.leadId}
          leadName={lead.name}
          tz={tz}
          reply={thread.reply}
          onSent={() => read()}
        />
      </div>
    );
  else if (lead.state === "writing" && lead.draft)
    composer = (
      <TypingComposer
        leadName={lead.name}
        speaker={speaker}
        draft={lead.draft}
        frozenAt={frozenAt}
        {...(mayMessage ? { onTakeOver } : {})}
      />
    );
  else if (lead.state === "with_you" && thread?.reply)
    composer = (
      <div className={s.mine}>
        <WhatsAppComposer
          key={`${lead.leadId}:${takenOverText ?? ""}`}
          leadId={lead.leadId}
          leadName={lead.name}
          tz={tz}
          reply={thread.reply}
          onSent={() => read()}
          initialText={takenOverText ?? ""}
          autoFocus
        />
        <Button size="sm" variant="ghost" className={s.handBack} onClick={onHandBack}>
          <AiGlyph size={14} />
          Hand back to LUME AI
        </Button>
      </div>
    );
  else if (!ended && ask && lead.state === "needs_you") {
    const p = ask.payload as { message?: string | null; fileIds?: string[] };
    const files = p.fileIds?.length ?? 0;
    composer = (
      <section className={s.bar} aria-label="What to do">
        <p className={s.barText}>
          <AiGlyph size={16} />
          <b>LUME AI asks: {AUTOPILOT_ACTION_TITLES[ask.action]}</b>
        </p>
        {p.message && <blockquote className={s.barQuote}>{p.message}</blockquote>}
        {files > 0 && (
          <p className={s.barNote}>
            {files === 1 ? "With a file from Media" : `With ${files} files from Media`}
          </p>
        )}
        {mayMessage && (
          <div className={s.barActions}>
            <Button size="sm" disabled={deciding} onClick={() => void decide(onDecline, ask.id)}>
              I&apos;ll reply
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={deciding}
              onClick={() => void decide(onApprove, ask.id)}
            >
              {p.message ? "Send it" : "Do it"}
            </Button>
          </div>
        )}
      </section>
    );
  } else if (stopped)
    // Where the reply box would be: plainly, that nobody from LUME AI will write to them again, and why.
    composer = (
      <section className={s.bar} data-tone="stop" aria-label="Stopped">
        <p className={s.barText}>
          <AiGlyph size={16} />
          <span>
            <b>LUME AI won&apos;t message {who} again.</b> {lead.reason}
          </span>
        </p>
      </section>
    );
  else if (!ended && (lead.state === "needs_you" || lead.state === "ready")) {
    const ready = lead.state === "ready";
    const why = ready
      ? (lead.card?.headline ?? null)
      : (lead.reason ?? lead.card?.headline ?? `${who} needs you.`);
    composer = (
      <section className={s.bar} aria-label="What to do">
        <p className={s.barText}>
          <AiGlyph size={16} />
          <span>
            {ready ? (
              <>
                <b>{who} is ready.</b> {why}
              </>
            ) : (
              <b>{why}</b>
            )}
          </span>
        </p>
        {/* Beside the words, not beside the reply box: the box takes a row of its own (owner, 2026-11-01). */}
        {mayMessage && canDecide && (
          <div className={s.barActions}>
            <Button size="sm" onClick={onCarryOn}>
              <AiGlyph size={14} />
              Let LUME AI carry on
            </Button>
          </div>
        )}
        {lead.card?.quote && <blockquote className={s.barQuote}>{`“${lead.card.quote}”`}</blockquote>}
        {/* The reply box itself (owner, 2026-11-01: "where is the text box?"): LUME AI is waiting on a person here, so
            what's typed is theirs. */}
        {thread?.reply && (
          <div className={s.mine}>
            <WhatsAppComposer
              key={lead.leadId}
              leadId={lead.leadId}
              leadName={lead.name}
              tz={tz}
              reply={thread.reply}
              onSent={() => read()}
            />
          </div>
        )}
      </section>
    );
  }

  return (
    <section className={s.convo} aria-label={`Conversation with ${lead.name}`}>
      <header className={s.convoHead}>
        <div className={s.convoWho}>
          <h2>{lead.name}</h2>
          <span data-tone={stopped ? "stop" : undefined}>{line}</span>
        </div>
        <Link href={`/leads?lead=${encodeURIComponent(lead.leadId)}`} className={s.openLead}>
          Open lead
        </Link>
        {dnc && (
          <LiftDoNotContact
            leadId={lead.leadId}
            who={who}
            onLifted={() => {
              setDnc(false);
              toast({
                tone: "ok",
                title: `${who} can be messaged again`,
                detail: "LUME lifted do not contact.",
              });
              read();
            }}
          />
        )}
        {working && mayMessage && (
          <Button size="sm" variant="primary" onClick={onTakeOver} aria-label={`Take over ${who}`}>
            Take over
          </Button>
        )}
      </header>
      <div className={s.thread} ref={scroller}>
        {thread ? (
          <WhatsAppThread
            leadName={lead.name}
            tz={tz}
            messages={thread.messages}
            composer={composer ?? <span />}
          />
        ) : problem ? (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        ) : (
          <div className={s.threadLoading} role="status" aria-busy aria-label="Getting the conversation">
            <Skeleton width="55%" height={38} radius={14} />
            <Skeleton width="40%" height={38} radius={14} />
            <Skeleton width="60%" height={38} radius={14} />
          </div>
        )}
      </div>
      {lead.thought && working && (
        <p className={s.why}>
          <b>Why</b> · {lead.thought}
        </p>
      )}
    </section>
  );
}

/** Lift do not contact, beside Open lead (owner 2026-11-04): the same word first as on the lead, then Keep it or Lift it. */
function LiftDoNotContact({ leadId, who, onLifted }: { leadId: string; who: string; onLifted(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lift = async (close: () => void) => {
    setBusy(true);
    setError(null);
    const r = await leadsClient.liftDoNotContact(leadId);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    close();
    onLifted();
  };
  return (
    <Popover
      label="Lift do not contact"
      trigger="Lift do not contact"
      triggerClassName={s.liftDnc}
      role="dialog"
      size="form"
      align="end"
    >
      {(close) => (
        <div className={s.liftAsk}>
          <p>
            Only lift this if {who} asked to hear from you again. LUME, LUME AI and your team can message{" "}
            {who} once it&apos;s lifted.
          </p>
          {error && (
            <p role="alert" className={s.liftError}>
              {error}
            </p>
          )}
          <div className={s.liftActions}>
            <Button size="sm" onClick={close} disabled={busy}>
              Keep it
            </Button>
            <Button size="sm" variant="danger" loading={busy} onClick={() => void lift(close)}>
              Lift it
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}
