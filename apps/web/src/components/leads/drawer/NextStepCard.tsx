"use client";
import type { NextStep } from "@lume/core/shared";
import { useEffect, useId, useRef, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { aiClient } from "@/lib/ai/client";
import type { AiPause, Applied, LeadAi, Part } from "@/lib/ai/types";
import { appliedWords, dueWords, pausedWords, type PartNames } from "@/lib/ai/words";
import { longDate, timeOf } from "@/lib/dates";
import { relativeTime, stageOf } from "@/lib/leads/format";
import type { Catalog } from "@/lib/leads/types";
import s from "./ai.module.css";

/** Where a suggestion comes from: a note or call just asked about, or one still waiting from before. */
export type NextStepSource =
  { activityId: string; kind: "call" | "note"; at: string } | { pending: NonNullable<LeadAi["pending"]> };
type Read = { id: string; suggestion: NextStep; dueAt: string | null };
type State =
  | { is: "reading" }
  | { is: "ready"; read: Read }
  | { is: "done"; read: Read; result: Applied }
  | { is: "limit"; pause: AiPause }
  | { is: "failed" }
  | { is: "gone" };
const PARTS: Part[] = ["stage", "followUp", "tags"];

/** What each part is called here, from the business's own lists; a part whose stage is gone isn't offered. */
function namesOf(read: Read, catalog: Catalog, tz: string): PartNames {
  const st = stageOf(catalog, read.suggestion.stageId);
  const reason = catalog.lostReasons.find((r) => r.id === read.suggestion.lostReasonId);
  return {
    stage: st ? (reason ? `${st.name} · ${reason.label}` : st.name) : null,
    when: read.suggestion.followUp && read.dueAt ? dueWords(read.dueAt, tz) : null,
    tags: read.suggestion.tagIds.flatMap((id) => catalog.tags.find((t) => t.id === id)?.label ?? []),
  };
}
const offered = (n: PartNames): Part[] =>
  PARTS.filter((p) => (p === "stage" ? n.stage : p === "followUp" ? n.when : n.tags.length));

/**
 * A suggested next step (spec 2026-10-18 §5.2; the approved canvas board NextStep): what the note means, and the
 * stage, follow-up and tags LUME AI suggests, each ticked. Apply does the ticked ones as the person; Dismiss forgets
 * it. Nothing is changed until the person says so.
 */
export function NextStepCard({
  leadId,
  tz,
  catalog,
  source,
  onApplied,
  onClose,
}: {
  leadId: string;
  tz: string;
  catalog: Catalog;
  source: NextStepSource;
  onApplied(): void;
  onClose(): void;
}) {
  const asked = "activityId" in source ? source.activityId : null;
  const [state, setState] = useState<State>(
    "pending" in source ? { is: "ready", read: source.pending } : { is: "reading" },
  );
  const [kept, setKept] = useState<Record<Part, boolean>>({ stage: true, followUp: true, tags: true });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const read = async () => {
    if (!asked) return;
    setState({ is: "reading" });
    const r = await aiClient.nextStep(leadId, asked);
    if (!live.current) return;
    if (!r.ok) return setState({ is: "failed" });
    const d = r.data;
    if (!("unavailable" in d)) return setState({ is: "ready", read: d.read });
    if (d.unavailable === "limit") return setState({ is: "limit", pause: { by: d.by, until: d.until } });
    if (d.unavailable === "failed") return setState({ is: "failed" });
    // Switched off (or never set up here) since the drawer looked: no card at all.
    setState({ is: "gone" });
    onClose();
  };
  useEffect(() => {
    void read();
    // One read per note asked about.
  }, [asked]);

  // A suggestion the person asked for, or the result of their Apply, is the next thing to read: focus goes there.
  // One already waiting when the drawer opens doesn't take focus from the lead's name.
  useEffect(() => {
    if ((state.is === "ready" && asked) || state.is === "done") heading.current?.focus();
  }, [state.is, asked]);

  if (state.is === "gone") return null;

  const apply = async (r: Read, parts: Part[]) => {
    setBusy(true);
    setProblem(null);
    const sent = Object.fromEntries(PARTS.map((p) => [p, parts.includes(p) && kept[p]])) as Record<
      Part,
      boolean
    >;
    const res = await aiClient.apply(r.id, sent);
    setBusy(false);
    if (!res.ok) return setProblem(res.message ?? "LUME couldn't apply this just now.");
    setState({ is: "done", read: r, result: res.data });
    onApplied();
  };
  const dismiss = async (r: Read) => {
    setBusy(true);
    // Gone either way: one already used elsewhere is just as finished.
    await aiClient.dismiss(r.id);
    setState({ is: "gone" });
    onClose();
  };
  const close = () => {
    setState({ is: "gone" });
    onClose();
  };

  return (
    <div aria-live="polite" className={s.live}>
      {state.is === "reading" && (
        <section aria-busy="true" aria-label="Suggested next step" className={s.card}>
          <p className={s.title}>
            <AiGlyph size={16} />
            LUME AI is reading your note…
          </p>
          <Skeleton width="82%" height={12} radius={6} />
          <Skeleton width="64%" height={12} radius={6} />
          <Skeleton width="72%" height={12} radius={6} />
        </section>
      )}

      {state.is === "ready" &&
        (() => {
          const r = state.read;
          const n = namesOf(r, catalog, tz);
          const parts = offered(n);
          const due = r.dueAt ? new Date(r.dueAt) : null;
          const from =
            "pending" in source
              ? `Suggested ${relativeTime(source.pending.from.at, undefined, tz)}`
              : `From your ${source.kind} at ${timeOf(new Date(source.at), tz)}`;
          return (
            <section aria-labelledby={titleId} className={s.card}>
              <div className={s.head}>
                <h3 id={titleId} ref={heading} tabIndex={-1} className={s.title}>
                  <AiGlyph size={16} />
                  Suggested next step
                </h3>
                <p className={s.summary}>{r.suggestion.summary}</p>
              </div>
              {parts.length > 0 && (
                <div className={s.parts}>
                  {parts.map((p) => (
                    <label key={p} className={s.part}>
                      <input
                        type="checkbox"
                        checked={kept[p]}
                        onChange={(e) => setKept((k) => ({ ...k, [p]: e.target.checked }))}
                      />
                      <span>
                        {p === "stage" && (
                          <>
                            Move to <b>{n.stage}</b>
                          </>
                        )}
                        {p === "followUp" && due && (
                          <>
                            Follow up{" "}
                            <b data-volatile>
                              {longDate(due, tz)} · {timeOf(due, tz)}
                            </b>{" "}
                            <span className={s.sub}>{r.suggestion.followUp?.title}</span>
                          </>
                        )}
                        {p === "tags" && (
                          <>
                            {n.tags.length === 1 ? "Add tag" : "Add tags"} <b>{n.tags.join(", ")}</b>
                          </>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {problem && (
                <p role="alert" className={s.problem}>
                  {problem}
                </p>
              )}
              <div className={s.foot}>
                {parts.length > 0 && (
                  <Button
                    variant="primary"
                    loading={busy}
                    disabled={!parts.some((p) => kept[p])}
                    onClick={() => void apply(r, parts)}
                  >
                    Apply
                  </Button>
                )}
                <Button variant="ghost" disabled={busy} onClick={() => void dismiss(r)}>
                  Dismiss
                </Button>
                <span className={s.from} data-volatile>
                  {from}
                </span>
              </div>
            </section>
          );
        })()}

      {state.is === "done" &&
        (() => {
          const w = appliedWords(state.result, namesOf(state.read, catalog, tz));
          return (
            <section aria-labelledby={titleId} className={s.done} data-tone={w.done ? "ok" : "quiet"}>
              <h3 id={titleId} ref={heading} tabIndex={-1} className={s.doneTitle}>
                {w.done && (
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                    <path d="M5 12.5 10 17l9-10" />
                  </svg>
                )}
                {w.done ? "Done" : "Nothing was changed"}
              </h3>
              {w.done && <p className={s.doneText}>{w.done}</p>}
              {w.skipped.map((t) => (
                <p key={t} className={s.skipped}>
                  {t}
                </p>
              ))}
              <div className={s.doneFoot}>
                <Button size="sm" variant="ghost" onClick={close}>
                  Close
                </Button>
              </div>
            </section>
          );
        })()}

      {state.is === "limit" && (
        <p role="status" className={s.note}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          {pausedWords(state.pause, tz)}
        </p>
      )}

      {state.is === "failed" && (
        <div role="status" className={s.note}>
          <span className={s.noteText}>{"LUME couldn't read this note just now."}</span>
          <Button onClick={() => void read()}>Try again</Button>
        </div>
      )}
    </div>
  );
}
