"use client";
import { IG_LIMITS, firstNameOf, textBytes } from "@lume/core/shared";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { instagramClient } from "@/lib/instagram/client";
import type { IgComment, IgMessage, IgThread, IgWindow } from "@/lib/instagram/types";
import { detailWords } from "@/lib/instagram/words";
import s from "./instagram.module.css";

type Props = {
  leadId: string;
  leadName: string;
  threads: IgThread[];
  me: { id: string; name: string };
  /** May message this lead (messages.send on it): the box, Take over, Hand back, private replies. */
  canSend: boolean;
  tz: string;
  /** The moment the window is read against (tests pin it). */
  now?: Date;
  /** Something changed on the server: the drawer reads the conversations again. */
  onChanged(): void;
};

/** Counted in Instagram's way (UTF-8 bytes); shown once a message is near the limit. */
const COUNT_FROM = 800;
const n = (v: number) => v.toLocaleString("en-US");

const time = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz })
    .format(new Date(iso))
    .toLowerCase();
const day = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz }).format(
    new Date(iso),
  );
const when = (iso: string, tz: string) => `${day(iso, tz)}, ${time(iso, tz)}`;

/** Meta's window in words, as it is now (spec 2026-11-22 §3; board Thread). */
function windowWords(w: IgWindow, first: string, now: Date, tz: string): string {
  if (w.state === "open") {
    const left = new Date(w.until).getTime() - now.getTime();
    const mins = Math.max(1, Math.ceil(left / 60_000));
    if (mins < 60)
      return `Open for ${mins} ${mins === 1 ? "minute" : "minutes"} · until ${time(w.until, tz)}`;
    const hours = Math.floor(left / 3_600_000);
    // An ad's 7 days: the day it ends, not a count of hours.
    if (hours >= 24) return `Open until ${when(w.until, tz)}`;
    return `Open for ${hours} ${hours === 1 ? "hour" : "hours"} · until ${time(w.until, tz)}`;
  }
  if (w.state === "human") return `Only a person can answer, until ${when(w.until, tz)}`;
  return w.since
    ? `Instagram’s 7 days ended ${when(w.since, tz)}. An answer can go once ${first} writes again.`
    : `No message from ${first} on Instagram yet. Instagram allows an answer only after a person writes.`;
}

const choicesOf = (d: Record<string, unknown>): string[] =>
  [d.quickReplies, d.buttons]
    .filter(Array.isArray)
    .flat()
    .map((x) => (x as { title?: unknown }).title)
    .filter((t): t is string => typeof t === "string");

const STATUS: Record<NonNullable<IgMessage["status"]>, string> = {
  queued: "Sending",
  sending: "Sending",
  sent: "Sent",
  read: "Seen",
  failed: "Didn’t go",
  cancelled: "Not sent",
};

function Message({
  m,
  tz,
  canRetry,
  onRetry,
}: {
  m: IgMessage;
  tz: string;
  canRetry: boolean;
  onRetry(m: IgMessage): void;
}) {
  const who =
    m.direction === "in" ? null : m.flow ? m.flow : m.fromPhone ? "From Instagram" : (m.sentBy?.name ?? null);
  const meta = [
    who,
    m.privateReply ? "private reply" : null,
    m.humanAgent ? "as a person" : null,
    time(m.at, tz),
    m.status ? STATUS[m.status] : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const extra = detailWords(m.detail);
  const choices = choicesOf(m.detail);
  return (
    <li className={s.msg} data-direction={m.direction}>
      <span className={s.meta}>{meta}</span>
      <div className={s.bubble}>
        {extra.map((e) => (
          <span key={e} className={s.extra}>
            {e}
          </span>
        ))}
        {m.unsent ? <span className={s.unsent}>Unsent</span> : m.text && <p className={s.text}>{m.text}</p>}
        {choices.length > 0 && (
          <span className={s.choices}>
            {choices.map((c, i) => (
              <span key={`${c}-${i}`} className={s.choice}>
                {c}
              </span>
            ))}
          </span>
        )}
        {m.reaction && (
          <span className={s.reaction} aria-label={`Reacted ${m.reaction}`}>
            {m.reaction}
          </span>
        )}
      </div>
      {m.status === "failed" && (
        <span className={s.failed}>
          <span>{m.problem ?? "Instagram didn’t take it."}</span>
          {canRetry && m.outboxId && (
            <Button size="sm" onClick={() => onRetry(m)}>
              Try again
            </Button>
          )}
        </span>
      )}
    </li>
  );
}

function CommentRow({
  c,
  tz,
  canReply,
  onSent,
}: {
  c: IgComment;
  tz: string;
  canReply: boolean;
  onSent(): void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const fieldId = useId();
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await instagramClient.privateReply(c.id, { clientKey: key.current, text: text.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    key.current = crypto.randomUUID();
    setOpen(false);
    setText("");
    onSent();
  };
  const state =
    c.privateReply === "sent"
      ? "Answered privately"
      : c.privateReply === "queued"
        ? "Private reply on its way"
        : c.privateReply === "failed"
          ? c.replyOpen
            ? "The private reply didn’t go"
            : "The private reply didn’t go, and its 7 days have ended"
          : c.replyOpen
            ? null
            : "Its 7 days for a private reply have ended";
  return (
    <li className={s.comment}>
      <p className={s.commentText}>{c.text || "A comment with no words"}</p>
      <span className={s.meta}>
        {[c.mediaType === "REELS" ? "On a reel" : c.mediaType ? "On a post" : null, when(c.at, tz), state]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {c.replyOpen && canReply && !open && (
        <Button size="sm" onClick={() => setOpen(true)}>
          Reply privately
        </Button>
      )}
      {open && (
        <div className={s.privateBox}>
          <label htmlFor={fieldId} className={s.srOnly}>
            Private reply to this comment
          </label>
          <textarea
            id={fieldId}
            className={s.input}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Lands in their DMs, once"
          />
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          <div className={s.row}>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={!text.trim() || textBytes(text) > IG_LIMITS.textBytes}
              onClick={() => void send()}
            >
              Send privately
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * A lead's Instagram conversation in its drawer (plan 2026-11-25-instagram-screens D2; canvas boards Thread,
 * ThreadDark, Phone): who has it now (a flow, you, someone, your team) with Take over and Hand back, the messages,
 * its comments and their one private reply, Meta's window in words, and the reply box while a person may answer.
 */
export function InstagramTab({
  leadId,
  leadName,
  threads,
  me,
  canSend,
  tz,
  now = new Date(),
  onChanged,
}: Props) {
  const [picked, setPicked] = useState(threads[0]?.id ?? "");
  const t = threads.find((x) => x.id === picked) ?? threads[0];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sentNow, setSentNow] = useState<Record<string, IgMessage[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per conversation's draft: a send that didn't go keeps its key, in its own conversation only.
  const keys = useRef<Record<string, string>>({});
  const fieldId = useId();
  if (!t) return null;
  const keyOf = (id: string) => (keys.current[id] ??= crypto.randomUUID());

  const first = firstNameOf(t.person.name ?? leadName) || leadName;
  const draft = drafts[t.id] ?? "";
  const setDraft = (v: string) => setDrafts((d) => ({ ...d, [t.id]: v }));
  const bytes = textBytes(draft);
  const tooLong = bytes > IG_LIMITS.textBytes;
  const mine = t.takenOver?.id === me.id;
  const flowHas = !!t.flow && !t.takenOver;
  const canType = canSend && t.account.connected && t.window.state !== "closed";
  const known = new Set(t.messages.map((m) => m.id));
  const messages = [...t.messages, ...(sentNow[t.id] ?? []).filter((m) => !known.has(m.id))];

  const act = async (how: "takeOver" | "handBack") => {
    setError(null);
    const r = await instagramClient[how](t.id);
    if (!r.ok) return setError(r.message);
    onChanged();
  };
  const deliver = async (text: string, retryOf?: string) => {
    setBusy(true);
    setError(null);
    const r = await instagramClient.send(leadId, {
      clientKey: retryOf ? crypto.randomUUID() : keyOf(t.id),
      threadId: t.id,
      text,
      ...(retryOf ? { retryOf } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    setSentNow((x) => ({ ...x, [t.id]: [...(x[t.id] ?? []), r.data.message] }));
    onChanged();
    return true;
  };
  const submit = async () => {
    const text = draft.trim();
    if (!text || tooLong || busy) return;
    if (await deliver(text)) {
      delete keys.current[t.id];
      setDraft("");
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit();
  };

  const driver = t.takenOver
    ? mine
      ? { chip: "You", note: `Nothing automated writes to ${first} until you hand ${first} back.` }
      : { chip: t.takenOver.name, note: `${t.takenOver.name} took this conversation over.` }
    : t.flow
      ? {
          chip: `Flow: ${t.flow.name}`,
          note: t.flow.waiting ? `The flow is waiting for ${first}’s answer.` : "The flow is answering now.",
        }
      : { chip: "Your team", note: "No flow is answering. Your team answers here." };

  let day0 = "";
  return (
    <section className={s.tab} aria-label={`Instagram with ${leadName}`}>
      <header className={s.head}>
        <img src="/brand/instagram.png" alt="" width={28} height={28} className={s.glyph} />
        <div className={s.who}>
          <b className={s.name} title={t.person.name ?? leadName}>
            {t.person.name ?? leadName}
          </b>
          <span className={s.handle}>
            {t.person.username && <span title={t.person.username}>{t.person.username}</span>}
            {t.person.username && " "}
            on @{t.account.username}
          </span>
        </div>
        {threads.length > 1 && (
          <label className={s.pick}>
            <span className={s.srOnly}>Conversation on</span>
            <select aria-label="Conversation on" value={t.id} onChange={(e) => setPicked(e.target.value)}>
              {threads.map((x) => (
                <option key={x.id} value={x.id}>
                  @{x.account.username}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <div className={s.driver}>
        <span className={s.chip} data-who={t.takenOver ? "person" : t.flow ? "flow" : "team"}>
          {driver.chip}
        </span>
        <span className={s.driverNote}>{driver.note}</span>
        {canSend && t.account.connected && flowHas && (
          <Button size="sm" onClick={() => void act("takeOver")}>
            Take over
          </Button>
        )}
        {canSend && t.takenOver && (
          <Button size="sm" variant="ghost" onClick={() => void act("handBack")}>
            Hand back
          </Button>
        )}
      </div>

      {!t.account.connected && (
        <p className={s.note}>
          @{t.account.username} isn’t connected to LUME now. Its messages stay here; replies can’t go until
          it’s connected again.
        </p>
      )}

      <ol className={s.list} aria-label="Messages">
        {messages.length === 0 && <li className={s.empty}>No messages in this conversation yet.</li>}
        {messages.map((m) => {
          const d = day(m.at, tz);
          const head = d !== day0;
          day0 = d;
          return [
            head && (
              <li key={`d-${m.id}`} className={s.day} aria-hidden>
                {d}
              </li>
            ),
            <Message
              key={m.id}
              m={m}
              tz={tz}
              canRetry={canType}
              onRetry={(x) => void deliver(x.text ?? "", x.outboxId ?? undefined)}
            />,
          ];
        })}
      </ol>

      {t.comments.length > 0 && (
        <section className={s.comments} aria-labelledby={`${fieldId}-c`}>
          <h3 id={`${fieldId}-c`} className={s.subhead}>
            Comments
          </h3>
          <ol aria-label="Comments" className={s.commentList}>
            {t.comments.map((c) => (
              <CommentRow
                key={c.id}
                c={c}
                tz={tz}
                canReply={canSend && t.account.connected}
                onSent={onChanged}
              />
            ))}
          </ol>
        </section>
      )}

      <p role="status" aria-label="Instagram’s window" className={s.window} data-state={t.window.state}>
        {windowWords(t.window, first, now, tz)}
      </p>

      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}

      {canType && (
        <div className={s.composer}>
          <label htmlFor={fieldId} className={s.srOnly}>
            Reply to {leadName} on Instagram
          </label>
          <textarea
            id={fieldId}
            className={s.input}
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              flowHas
                ? `Type to take over from ${t.flow!.name}…`
                : t.takenOver && !mine
                  ? `Type to take over from ${t.takenOver.name}…`
                  : `Reply to ${first}…`
            }
          />
          <div className={s.row}>
            <span className={s.hint}>
              {t.window.state === "human"
                ? "Instagram marks a reply now as a person’s. Flows never use it."
                : flowHas
                  ? `Typing takes this conversation over. Nothing automated writes to ${first} until you hand ${first} back.`
                  : "Enter to send · Shift+Enter for a new line"}
            </span>
            {bytes >= COUNT_FROM && (
              <span className={s.count} data-over={tooLong || undefined}>
                {n(bytes)} of {n(IG_LIMITS.textBytes)}
              </span>
            )}
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={!draft.trim() || tooLong}
              onClick={() => void submit()}
            >
              Send
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
