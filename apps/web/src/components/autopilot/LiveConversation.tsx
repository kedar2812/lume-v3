"use client";
import { firstNameOf } from "@lume/core/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { WhatsAppComposer } from "@/components/leads/drawer/WhatsAppComposer";
import { WhatsAppThread } from "@/components/leads/drawer/WhatsAppThread";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import type { RunLead } from "@/lib/autopilot/types";
import { useAutopilot } from "@/lib/notifications/stream";
import { useStickToBottom } from "@/lib/ui/use-stick-to-bottom";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaThread } from "@/lib/whatsapp/types";
import { STATE_WORDS } from "./LeadList";
import { TypingComposer } from "./TypingComposer";
import s from "./live.module.css";

/** LUME AI is still working these: a person may take one over (§2.1). */
const WORKING = ["up_next", "writing", "sent", "replied", "talking"];

/**
 * The live conversation (spec 2026-10-19 §2): the lead's WhatsApp thread, LUME AI's one-line thought in its own words,
 * and the composer where it types. Watching a lead other than LUME AI's offers the way back. A lead taken over is the
 * person's: their own reply box, starting from LUME AI's half-typed words, and Hand back. Someone who may not message
 * the lead watches only.
 */
export function LiveConversation({
  lead,
  current,
  tz,
  speaker,
  frozenAt,
  takenOverText,
  onBack,
  onTakeOver,
  onHandBack,
}: {
  lead: RunLead;
  /** This is the lead LUME AI is on. */
  current: boolean;
  tz: string;
  speaker: string;
  /** The run was paused at this moment: the typing stops where it was. */
  frozenAt: Date | null;
  /** LUME AI's half-typed words, handed over with the lead. */
  takenOverText: string | null;
  onBack(): void;
  onTakeOver(): void;
  onHandBack(): void;
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

  // The newest message stays in view as messages arrive and LUME AI types, unless someone scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null);
  useStickToBottom(scroller, `${thread?.messages.length ?? 0}:${lead.state}`);

  const mayMessage = !!thread?.reply;
  const working = WORKING.includes(lead.state);

  let composer = null;
  if (lead.state === "writing" && lead.draft)
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
  else if (working && mayMessage)
    composer = (
      <div className={s.watching}>
        <p>LUME AI is working this conversation for you.</p>
        <Button size="sm" onClick={onTakeOver} aria-label={`Take over ${who}`}>
          Take over
        </Button>
      </div>
    );

  return (
    <section className={s.convo} aria-label={`Conversation with ${lead.name}`}>
      <header className={s.convoHead}>
        <div>
          <h2>{lead.name}</h2>
          <span className={s.stateChip} data-state={lead.state}>
            {STATE_WORDS[lead.state]}
          </span>
        </div>
        {!current && (
          <Button size="sm" variant="ghost" onClick={onBack}>
            Back to LUME AI&apos;s lead
          </Button>
        )}
      </header>
      {lead.thought && working && (
        <p className={s.thought}>
          <AiGlyph size={14} />
          <span>{lead.thought}</span>
        </p>
      )}
      {(lead.state === "ready" ||
        lead.state === "needs_you" ||
        lead.state === "stopped" ||
        lead.state === "skipped") &&
        lead.reason && <p className={s.reasonLine}>{lead.reason}</p>}
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
          <div className={s.threadLoading} aria-busy aria-label="Getting the conversation">
            <Skeleton width="55%" height={38} radius={14} />
            <Skeleton width="40%" height={38} radius={14} />
            <Skeleton width="60%" height={38} radius={14} />
          </div>
        )}
      </div>
    </section>
  );
}
