"use client";
import { REPLY_MEANING_WORDS, wallTime, type ReplyMeaningGroup } from "@lume/core/shared";
import Link from "next/link";
import { useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { useZone } from "@/components/ZoneProvider";
import { Button } from "@/components/ui/Button";
import { bulkRunsClient, runLine, type RunView } from "@/lib/leads/bulk-runs";
import { relativeTime } from "@/lib/leads/format";
import type { BulkAction } from "@/lib/leads/types";
import { repliesClient, type ReplyBoard, type ReplyBoardLead } from "@/lib/replies/client";
import s from "./replies.module.css";

type Stage = { id: string; name: string; kind: "open" | "won" | "lost" };
/** What a follow-up from each group is called (the person can't type one here; it's on each lead after). */
const FOLLOW_UP_TITLE: Partial<Record<ReplyMeaningGroup, string>> = {
  price: "Reply about the price",
  visit_or_call: "Arrange the visit or call",
  later: "Check back with them",
};
/** "2026-11-10T11:00" on the business's clock, as a moment; null when it isn't one. */
function moment(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  return wallTime(y, mo, d, h, mi, tz).toISOString();
}
/** Tomorrow at 11 on the business's clock, as the follow-up box starts. */
function tomorrowAt11(tz: string): string {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + 86_400_000));
  return `${day}T11:00`;
}

/**
 * Who replied (W2, spec 2026-10-18 §4.2): each lead's latest WhatsApp reply since a moment, grouped by what LUME AI read
 * it to mean; each group's own bulk action (move along, follow up, mark lost, do not contact), done as one bulk run with
 * Undo. Stop messaging is done already: LUME marked them do not contact when they said it.
 */
export function RepliesBoard({
  initial,
  stages,
  lostReasons,
  canBulk,
}: {
  initial: ReplyBoard;
  /** The default pipeline's stages (where a group moves to, and its lost stage). */
  stages: Stage[];
  lostReasons: { id: string; label: string }[];
  /** May change many leads at once (leads.bulk_edit). */
  canBulk: boolean;
}) {
  const tz = useZone();
  const { toast } = useToast();
  const [board, setBoard] = useState(initial);
  const [busy, setBusy] = useState<ReplyMeaningGroup | null>(null);
  const shown = board.groups.filter((g) => g.count > 0);
  const lost = stages.find((x) => x.kind === "lost") ?? null;

  const reload = async () => {
    const r = await repliesClient.board(board.since);
    if (r.ok) setBoard(r.data);
  };
  const runFor = async (group: ReplyMeaningGroup, leads: ReplyBoardLead[], action: BulkAction) => {
    setBusy(group);
    const r = await bulkRunsClient.create({ ids: leads.map((l) => l.leadId) }, action);
    setBusy(null);
    if (!r.ok) return toast({ tone: "warn", title: "LUME couldn't do that", detail: r.message });
    const names = {
      person: () => "someone",
      stage: (id: string) => stages.find((x) => x.id === id)?.name ?? "a stage",
      tag: () => "a tag",
    };
    const done: RunView = { ...r.data.run, action };
    toast({
      tone: "ok",
      title: runLine(done, names),
      action: {
        label: "Undo",
        onClick: () =>
          void bulkRunsClient.undo(r.data.run.id).then((u) => {
            if (!u.ok) toast({ tone: "warn", title: "LUME couldn't put them back", detail: u.message });
            void reload();
          }),
      },
    });
    void reload();
  };

  if (!shown.length)
    return (
      <div className={s.empty}>
        <p>
          No WhatsApp replies since {relativeTime(board.since, new Date(), tz)}. When leads write back, they
          show up here, grouped by what they mean.
        </p>
      </div>
    );

  return (
    <div className={s.board}>
      {shown.map((g) => (
        <section
          key={g.group}
          className={s.group}
          data-group={g.group}
          aria-label={`${REPLY_MEANING_WORDS[g.group]}, ${g.count}`}
        >
          <header className={s.head}>
            <h2>{REPLY_MEANING_WORDS[g.group]}</h2>
            <span className={s.count}>{g.count.toLocaleString("en-US")}</span>
          </header>
          <ul className={s.leads}>
            {g.leads.map((l) => (
              <li key={l.leadId}>
                <Link href={`/leads?lead=${l.leadId}`} className={s.lead}>
                  <b>{l.name}</b>
                  <span className={s.when}>{relativeTime(l.at, new Date(), tz)}</span>
                </Link>
                {(l.summary ?? l.text) && <p className={s.said}>{l.summary ?? l.text}</p>}
              </li>
            ))}
          </ul>
          {g.group === "stop" ? (
            <p className={s.note}>LUME marked these do not contact.</p>
          ) : (
            canBulk && (
              <GroupAction
                group={g.group}
                count={g.leads.length}
                busy={busy === g.group}
                stages={stages.filter((x) => x.kind === "open")}
                lostStage={lost}
                lostReasons={lostReasons}
                tz={tz}
                onRun={(action) => void runFor(g.group, g.leads, action)}
              />
            )
          )}
        </section>
      ))}
    </div>
  );
}

/** A group's own bulk action, in words: what fits what they said. */
function GroupAction({
  group,
  count,
  busy,
  stages,
  lostStage,
  lostReasons,
  tz,
  onRun,
}: {
  group: ReplyMeaningGroup;
  count: number;
  busy: boolean;
  stages: Stage[];
  lostStage: Stage | null;
  lostReasons: { id: string; label: string }[];
  tz: string;
  onRun(a: BulkAction): void;
}) {
  const [stageId, setStageId] = useState("");
  const [reasonId, setReasonId] = useState("");
  const [when, setWhen] = useState(() => tomorrowAt11(tz));
  const them = count === 1 ? "the 1" : `the ${count}`;

  if (group === "interested" || group === "not_sure")
    return (
      <div className={s.action}>
        <select
          className={s.select}
          aria-label={`Move ${them} to`}
          value={stageId}
          onChange={(e) => setStageId(e.target.value)}
        >
          <option value="">Move {them} to…</option>
          {stages.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <Button size="sm" disabled={!stageId || busy} onClick={() => onRun({ type: "stage", stageId })}>
          Move
        </Button>
      </div>
    );
  const title = FOLLOW_UP_TITLE[group];
  if (title) {
    const at = moment(when, tz);
    return (
      <div className={s.action}>
        <label className={s.when}>
          Follow up on
          <input
            type="datetime-local"
            className={s.input}
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </label>
        <Button
          size="sm"
          disabled={!at || busy}
          onClick={() => at && onRun({ type: "follow_up", at, title })}
        >
          Set follow-up
        </Button>
      </div>
    );
  }
  if (group === "not_interested" && lostStage)
    return (
      <div className={s.action}>
        <select
          className={s.select}
          aria-label="Lost because"
          value={reasonId}
          onChange={(e) => setReasonId(e.target.value)}
        >
          <option value="">Lost because…</option>
          {lostReasons.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={!reasonId || busy}
          onClick={() => onRun({ type: "stage", stageId: lostStage.id, lostReasonId: reasonId })}
        >
          Mark lost
        </Button>
      </div>
    );
  if (group === "wrong_number")
    return (
      <div className={s.action}>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onRun({ type: "do_not_contact", reason: "Wrong number" })}
        >
          Mark do not contact
        </Button>
      </div>
    );
  return null;
}
