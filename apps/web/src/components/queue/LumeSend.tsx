"use client";
import { useEffect, useId, useState } from "react";
import { WhatsAppThread } from "@/components/leads/drawer/WhatsAppThread";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { WhatsAppIcon } from "@/components/ui/WhatsAppIcon";
import type { LumeChannel } from "@/lib/queues/client";
import type { WaThreadMessage } from "@/lib/whatsapp/types";
import { missingIn } from "@/lib/messages/missing";
import s from "./run.module.css";

/** Where a lead sent from LUME is: ready, going, taken by WhatsApp, refused by it, or slow to answer. */
export type LumePhase = "ready" | "sending" | "sent" | "failed" | "slow";
type Mode = "message" | "template";
/** The conversation shows its newest messages: enough to answer, never a whole history. */
const SHOWN = 30;

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);

/** When they last wrote, as people say it: "just now", "25 minutes ago", "3 hours ago". */
export function agoWords(iso: string, now: Date): string {
  const mins = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(mins / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

/**
 * One lead of the run, sent from inside LUME (spec 2026-11-26-focus-run-in-lume): their WhatsApp conversation with
 * the business, then what can go. Outside WhatsApp's 24 hours, the run's approved template in their words (read only);
 * inside them, a line saying so and a choice: Message (the run's words, editable; the default) or Template.
 */
export function LumeSend({
  leadName,
  tz,
  channel,
  messages,
  phase,
  problem,
  now,
  active = true,
  onSend,
  onSkip,
  onRetry,
}: {
  leadName: string;
  tz: string;
  channel: Extract<LumeChannel, { via: "lume" }>;
  /** Null while the conversation loads. */
  messages: WaThreadMessage[] | null;
  phase: LumePhase;
  /** WhatsApp's words when it refused the message. */
  problem: string | null;
  now?: Date;
  /** The card in front (not one sliding out): it answers Enter and the keys. */
  active?: boolean;
  onSend(body: { mode: Mode; text?: string }): void;
  onSkip(): void;
  onRetry(): void;
}) {
  const id = useId();
  const both = channel.window.open && !!channel.template;
  const [mode, setMode] = useState<Mode>(channel.window.open ? "message" : "template");
  const [text, setText] = useState(channel.text ?? "");
  // A new lead, or this one looked at again and its 24 hours ended: start from what it allows now. Looked at again
  // for anything else (an error), the words being written stay.
  useEffect(() => {
    setMode(channel.window.open ? "message" : "template");
    setText(channel.text ?? "");
  }, [channel.window.open, channel.text]);
  // M and T pick Message or Template, unless the person is typing.
  useEffect(() => {
    if (!both || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "m") setMode("message");
      if (k === "t") setMode("template");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [both, active]);

  const effective: Mode = channel.window.open ? (channel.template ? mode : "message") : "template";
  const t = channel.template;
  const missing = effective === "template" && t ? t.missing : [];
  // A value the words name but this lead hasn't got: never sent to them as {{…}}.
  const unfilled = effective === "message" ? missingIn(text) : [];
  const ready = phase === "ready";
  const canSend =
    ready &&
    !channel.blocked &&
    (effective === "message" ? !!text.trim() && unfilled.length === 0 : !!t && missing.length === 0);
  const shown = messages ? messages.slice(-SHOWN) : null;

  return (
    <form
      data-queue-form={active ? "" : undefined}
      className={s.lume}
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSend) return;
        onSend(effective === "message" ? { mode: "message", text } : { mode: "template" });
      }}
    >
      <div className={s.convo} aria-label={`WhatsApp with ${leadName}`} role="log">
        {shown === null ? null : shown.length ? (
          <WhatsAppThread leadName={leadName} tz={tz} messages={shown} bare />
        ) : (
          <p className={s.empty}>No messages with them yet</p>
        )}
      </div>

      {channel.window.open && channel.window.lastInAt && (
        <p className={s.window}>
          <i aria-hidden />
          Wrote {agoWords(channel.window.lastInAt, now ?? new Date())} · you can text them directly
        </p>
      )}

      {channel.blocked ? (
        <p className={s.note}>{channel.blocked}</p>
      ) : (
        <>
          {both && (
            <SegmentedControl
              label="Send as"
              size="sm"
              value={mode}
              options={[
                { value: "message", label: "Message" },
                { value: "template", label: "Template" },
              ]}
              onChange={(v) => setMode(v as Mode)}
            />
          )}
          {effective === "message" ? (
            <textarea
              id={`${id}-text`}
              aria-label={`Message to ${leadName}`}
              className={s.text}
              rows={5}
              maxLength={4096}
              value={text}
              disabled={!ready}
              placeholder={`Hi ${leadName.split(" ")[0] ?? ""},`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
          ) : (
            t && (
              <>
                <p className={s.preview}>{t.preview}</p>
                <p className={s.via}>Sends your approved template {t.name}</p>
              </>
            )
          )}
          {missing.length > 0 && (
            <p className={s.note}>Needs their {missing.join(" and ")} filled in first</p>
          )}
          {unfilled.length > 0 && (
            <p className={s.note}>Missing: {unfilled.join(", ")}. Fill it in before sending.</p>
          )}
        </>
      )}

      {phase === "failed" && (
        <div role="alert" className={s.failed}>
          <span>{problem ?? "WhatsApp didn't take it."}</span>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
      {(phase === "sent" || phase === "slow") && (
        <p role="status" className={s.away}>
          {phase === "sent" ? "Sent" : "Still sending, LUME will keep trying"}
        </p>
      )}

      {(phase === "ready" || phase === "sending" || phase === "failed") && (
        <div className={s.actions}>
          <Button type="button" variant="ghost" onClick={onSkip} disabled={phase === "sending"}>
            Skip
          </Button>
          {!channel.blocked && phase !== "failed" && (
            <Button type="submit" variant="whatsapp" disabled={!canSend}>
              <WhatsAppIcon size={18} ring />
              {phase === "sending" ? "Sending…" : "Send"}
            </Button>
          )}
        </div>
      )}
      <p className={s.keys} aria-hidden>
        {channel.blocked ? (
          <>
            <Kbd>S</Kbd> Skip · <Kbd>P</Kbd> Pause · <Kbd>Esc</Kbd> Leave
          </>
        ) : (
          <>
            <Kbd>↵</Kbd> Send ·{" "}
            {both && (
              <>
                <Kbd>M</Kbd> Message · <Kbd>T</Kbd> Template ·{" "}
              </>
            )}
            <Kbd>S</Kbd> Skip · <Kbd>P</Kbd> Pause · <Kbd>Esc</Kbd> Leave
          </>
        )}
      </p>
    </form>
  );
}
