"use client";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { can, scopeOf } from "@lume/core/shared";
import { useToast } from "@/components/feedback/ToastProvider";
import { CountryPicker } from "@/components/ui/CountryPicker";
import { StartRun } from "@/components/queue/StartRun";
import {
  bulkRunsClient,
  isLive,
  reasonWords,
  runLine,
  took,
  type RunView,
  type SelectionBody,
} from "@/lib/leads/bulk-runs";
import type { BulkAction } from "@/lib/leads/types";
import { useBulkRun } from "@/lib/leads/use-bulk-run";
import type { Session } from "@/server/session";
import { useCatalog } from "../CatalogProvider";
import s from "./island.module.css";

type Menu = "stage" | "assign" | "tags" | "more" | null;
const fmt = (n: number) => n.toLocaleString("en-US");
/** A part of the island that isn't showing is out of reach too: hidden from screen readers, and inert. */
const away = (on: boolean) => (on ? {} : { "aria-hidden": true as const, inert: true });
const leadsWord = (n: number) => `${fmt(n)} ${n === 1 ? "lead" : "leads"}`;

const Ico = {
  stage: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M8 7v7M12 7v4M16 7v9" />
    </svg>
  ),
  assign: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  ),
  tag: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
    </svg>
  ),
  more: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M5 12h.01M12 12h.01M19 12h.01" />
    </svg>
  ),
  close: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
  tick: (
    <svg
      className={s.tick}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  undo: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  ),
  hide: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13 5h6v6" />
      <path d="M19 5 5 19" />
    </svg>
  ),
  check: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
};

/**
 * The bulk island (7C): the leads selected, what to do with them, the run while it goes, and its result with
 * Undo. Up to 500 leads change in the request; more run in the background, read back every second.
 */
export function Island({
  session,
  count,
  allMatching,
  selection,
  leadIds,
  phoneFixable,
  onRun,
  onFinished,
  onClear,
}: {
  session: Session;
  /** How many are selected (all that match counts every one of them). */
  count: number;
  allMatching: boolean;
  /** The selection as the API takes it, made when an action starts. */
  selection: () => SelectionBody;
  /** Picked ids, for Message (a send queue); none when the selection is everything that matches. */
  leadIds: string[];
  phoneFixable: boolean;
  /** Every change to the run (the rail and the rows follow it). */
  onRun?: (run: RunView | null) => void;
  /** A run (or its undo) finished: reload the list and its counts. */
  onFinished: (run: RunView) => void;
  onClear: () => void;
}) {
  const catalog = useCatalog();
  const { toast } = useToast();
  const actor = session.actor;
  const [menu, setMenu] = useState<Menu>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [tagOp, setTagOp] = useState<"add" | "remove">("add");
  const [lost, setLost] = useState<string | null>(null);
  const [more, setMore] = useState<"list" | "phone" | "delete">("list");
  const [country, setCountry] = useState(catalog.country ?? "");
  const [started, setStarted] = useState<RunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  const [tucked, setTucked] = useState(false);
  const run = useBulkRun(started);
  const live = isLive(run);
  const told = useRef<string | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("lume-topbar-slot")), []);

  useEffect(() => onRun?.(run), [run, onRun]);

  // Keyboard focus follows the island (7C final review, Important 4): a part that's put away is inert, so whatever
  // had focus in it is gone; focus moves to what's now in front — Stop while it runs, Undo or Close when it's done,
  // the top-bar pill once hidden.
  const root = useRef<HTMLDivElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const runningRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const miniRef = useRef<HTMLButtonElement>(null);
  const triggers = useRef<Partial<Record<NonNullable<Menu>, HTMLButtonElement | null>>>({});
  const phase = !run ? "select" : isLive(run) ? "running" : "finished";
  const ours = () => {
    const a = document.activeElement;
    return !a || a === document.body || !!root.current?.contains(a) || !!miniRef.current?.contains(a);
  };
  useEffect(() => {
    if (tucked || !ours()) return;
    if (phase === "running") (stopRef.current ?? runningRef.current)?.focus();
    if (phase === "finished") (undoRef.current ?? closeRef.current)?.focus();
  }, [phase, tucked]);
  useEffect(() => {
    if (tucked) miniRef.current?.focus();
  }, [tucked]);
  // An open menu takes focus at its first choice; Esc puts it away and focus back on what opened it.
  useEffect(() => {
    if (!menu) return;
    const pane = root.current?.querySelector<HTMLElement>(`[data-pane="${menu}"]`);
    pane?.querySelector<HTMLElement>('[role="menuitemradio"], button:not([disabled])')?.focus();
  }, [menu]);
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && menu) {
      e.preventDefault();
      const m = menu;
      setMenu(null);
      triggers.current[m]?.focus();
      return;
    }
    if (
      (e.key === "ArrowDown" || e.key === "ArrowUp") &&
      (e.target as HTMLElement).getAttribute("role") === "menuitemradio"
    ) {
      e.preventDefault();
      const items = [
        ...((e.target as HTMLElement)
          .closest('[role="menu"]')
          ?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
      ];
      const i = items.indexOf(e.target as HTMLElement);
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  };

  // What a screen reader hears: once when it starts, at halfway, and when it's done — not every tick (Important 6).
  const [said, setSaid] = useState("");
  const half = useRef<string | null>(null);
  // A run that finished is told once: the list reloads, and its counts.
  useEffect(() => {
    if (!run || live || told.current === run.id + run.status) return;
    told.current = run.id + run.status;
    onFinished(run);
  }, [run, live, onFinished]);

  const pipeline = catalog.pipelines.find((p) => p.isDefault) ?? catalog.pipelines[0];
  const stages = [...(pipeline?.stages ?? [])].sort((a, b) => a.position - b.position);
  const people = catalog.people.filter((p) => p.active);
  const name = {
    person: (id: string | null) => people.find((p) => p.id === id)?.name ?? "someone",
    stage: (id: string) =>
      catalog.pipelines.flatMap((p) => p.stages).find((x) => x.id === id)?.name ?? "a stage",
    tag: (id: string) => catalog.tags.find((t) => t.id === id)?.label ?? "a tag",
  };
  const bulk = can(actor, "leads.bulk_edit");
  const n = count;
  const queued = n > 500;

  const open = (m: Menu) => {
    setMenu((cur) => (cur === m ? null : m));
    setPick(null);
    setLost(null);
    setMore("list");
    setError(null);
  };
  const start = async (action: BulkAction) => {
    setBusy(true);
    setError(null);
    const r = await bulkRunsClient.create(selection(), action);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setMenu(null);
    setWhy(false);
    setTucked(false);
    setStarted(r.data.run);
  };
  const undo = async () => {
    if (!run) return;
    const r = await bulkRunsClient.undo(run.id);
    if (!r.ok) return toast({ tone: "warn", title: "LUME couldn’t undo that", detail: r.message });
    setWhy(false);
    setStarted(r.data.run);
  };
  const stop = async () => {
    if (!run) return;
    const r = await bulkRunsClient.cancel(run.id);
    if (!r.ok) toast({ tone: "warn", title: "LUME couldn’t stop it", detail: r.message });
  };
  const close = () => {
    setStarted(null);
    setWhy(false);
    setTucked(false);
    onRun?.(null);
    onClear();
    // The island goes: focus goes back to the list it came from (7C final review, Important 4).
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[aria-label="Select all loaded"]')?.focus(),
    );
  };

  // the shape follows what the island holds
  const finished = !!run && !live;
  const paneH = {
    stage: pick ? (stages.find((x) => x.id === pick)?.kind === "lost" ? 400 : 340) : 290,
    assign: Math.min(420, 120 + people.length * 42 + (pick ? 76 : 0)),
    tags: Math.min(420, 110 + catalog.tags.length * 42 + (pick ? 60 : 0)),
    more: more === "list" ? 130 : more === "delete" ? 176 : 250,
  };
  let w = 700,
    h = 56,
    r = 28;
  if (menu && !run) {
    h = 56 + paneH[menu];
    r = 26;
  }
  if (live) {
    w = 740;
    h = 64;
    r = 32;
  }
  if (finished) {
    w = 720;
    h = 64 + (why ? 190 : 0);
    r = why ? 26 : 32;
  }
  const shown = !!run || n > 0;
  const total = run ? run.total : 0;
  const processed = run ? run.done + run.skipped : 0;
  const p = total ? processed / total : 0;
  const undoing = run?.action.type === "undo";
  const fill = undoing ? (live ? 1 - p : 0) : live ? p : run?.status === "done" ? 1 : 0;
  const chunks = Math.max(1, Math.ceil(total / 500));
  const batch = Math.min(chunks, Math.floor(processed / 500) + 1);
  const skippedBy = Object.entries(run?.skippedBy ?? {});
  const pickedName = (list: { id: string; name?: string; label?: string }[]) => {
    const x = list.find((i) => i.id === pick);
    return x?.name ?? x?.label ?? "";
  };

  const finishedTitle = () => {
    if (!run) return "";
    if (run.status === "cancelled") return `Stopped at ${fmt(processed)} of ${fmt(run.total)}`;
    if (run.status === "failed") return `Stopped at ${fmt(processed)} of ${fmt(run.total)}`;
    return runLine(run, name);
  };
  const finishedSub = () => {
    if (!run) return "";
    if (run.status === "failed")
      return run.error === "Their access changed"
        ? "Your access changed, so it stopped. What was done stays."
        : "It stopped. What was done stays.";
    if (run.status === "cancelled") return `${fmt(run.done)} changed; the rest weren’t touched`;
    // Everything a filter showed: if more (or fewer) matched by the time it ran, say so (7B final review, Important 4).
    const sel = run.selection;
    const drift =
      sel.kind === "filter" && sel.expected !== undefined && sel.total !== sel.expected
        ? ` · ${fmt(sel.total)} matched by then, not the ${fmt(sel.expected)} you saw`
        : "";
    return (took(run) ?? "Done") + drift;
  };

  useEffect(() => {
    if (!run) return setSaid("");
    if (isLive(run)) {
      if (!(half.current ?? "").startsWith(run.id)) {
        half.current = `${run.id}:start`;
        setSaid(`${runLine(run, name)}. LUME will say when it’s done.`);
      } else if (p >= 0.5 && total > 0 && half.current === `${run.id}:start`) {
        half.current = `${run.id}:half`;
        setSaid(`Halfway: ${fmt(processed)} of ${fmt(total)}.`);
      }
      return;
    }
    setSaid(`${finishedTitle()}.`);
    // Announced on the run's turning points only.
  }, [run?.id, run?.status, p >= 0.5]);

  return (
    <>
      <div
        ref={root}
        onKeyDown={keys}
        className={`${s.isle} ${shown ? "" : s.out} ${tucked ? s.tucked : ""}`}
        style={{ "--w": `${w}px`, "--h": `${h}px`, "--r": `${r}px` } as CSSProperties}
        {...away(shown && !tucked)}
      >
        <div
          className={`${s.liq} ${run?.status === "done" && !undoing ? s.liqOk : ""} ${undoing ? s.liqCalm : ""}`}
          style={{ "--p": fill } as CSSProperties}
        />

        {/* the pickers: the island grows up into them */}
        <div
          className={`${s.pane} ${menu === "stage" && !run ? s.paneOn : ""}`}
          role="menu"
          data-pane="stage"
          aria-label="Move to stage"
          {...away(menu === "stage" && !run)}
        >
          <div className={s.ph}>
            <span>Move {fmt(n)} to</span>
          </div>
          {stages.map((st) => (
            <button
              key={st.id}
              type="button"
              role="menuitemradio"
              aria-checked={pick === st.id}
              className={s.io}
              onClick={() => {
                setPick(st.id);
                setLost(null);
              }}
            >
              <span
                className={s.dot}
                style={{
                  background: `var(--${st.color === "neutral" ? "text-3" : st.color === "accent" ? "accent" : st.color})`,
                }}
              />
              {st.name}
              {Ico.tick}
            </button>
          ))}
          <div className={`${s.go} ${pick ? s.goOn : ""}`} {...away(!!pick)}>
            <div>
              <div className={s.goIn}>
                {stages.find((x) => x.id === pick)?.kind === "lost" && (
                  <div className={s.chips} role="group" aria-label="Why were they lost?">
                    {catalog.lostReasons.map((lr) => (
                      <button
                        key={lr.id}
                        type="button"
                        className={s.chip}
                        aria-pressed={lost === lr.id}
                        onClick={() => setLost(lr.id)}
                      >
                        {lr.label}
                      </button>
                    ))}
                  </div>
                )}
                {error && (
                  <div className={s.err} role="alert">
                    {error}
                  </div>
                )}
                <button
                  type="button"
                  className={`${s.commit} ${stages.find((x) => x.id === pick)?.kind === "lost" ? s.red : ""}`}
                  disabled={busy || (stages.find((x) => x.id === pick)?.kind === "lost" && !lost)}
                  onClick={() =>
                    pick &&
                    void start({ type: "stage", stageId: pick, ...(lost ? { lostReasonId: lost } : {}) })
                  }
                >
                  {stages.find((x) => x.id === pick)?.kind === "lost" && !lost
                    ? "Choose one reason for all of them"
                    : `Move ${fmt(n)} to ${pickedName(stages)}`}
                </button>
                <div className={s.note}>
                  {stages.find((x) => x.id === pick)?.kind === "lost"
                    ? ""
                    : "Each stage’s automations run, as they do for one lead. "}
                  {queued ? "LUME will let you know when it’s done." : ""}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          className={`${s.pane} ${menu === "assign" && !run ? s.paneOn : ""}`}
          role="menu"
          data-pane="assign"
          aria-label="Assign to"
          {...away(menu === "assign" && !run)}
        >
          <div className={s.ph}>
            <span>Assign {fmt(n)} to</span>
          </div>
          {people.map((pp) => (
            <button
              key={pp.id}
              type="button"
              role="menuitemradio"
              aria-checked={pick === pp.id}
              className={s.io}
              onClick={() => setPick(pp.id)}
            >
              {pp.name}
              {Ico.tick}
            </button>
          ))}
          {scopeOf(actor, "leads.assign") === "all" && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={pick === "none"}
              className={s.io}
              onClick={() => setPick("none")}
            >
              Nobody yet{Ico.tick}
            </button>
          )}
          <div className={`${s.go} ${pick ? s.goOn : ""}`} {...away(!!pick)}>
            <div>
              <div className={s.goIn}>
                {error && (
                  <div className={s.err} role="alert">
                    {error}
                  </div>
                )}
                <button
                  type="button"
                  className={s.commit}
                  disabled={busy}
                  onClick={() =>
                    pick && void start({ type: "assign", ownerId: pick === "none" ? null : pick })
                  }
                >
                  {pick === "none"
                    ? `Leave ${fmt(n)} with nobody`
                    : `Assign ${fmt(n)} to ${pickedName(people).split(" ")[0]}`}
                </button>
                {pick && pick !== "none" && (
                  <div className={s.note}>
                    {pickedName(people).split(" ")[0]} gets one notice for all of them
                    {n > 1 ? `, not ${fmt(n)}` : ""}.{queued ? " LUME will let you know when it’s done." : ""}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div
          className={`${s.pane} ${menu === "tags" && !run ? s.paneOn : ""}`}
          role="menu"
          data-pane="tags"
          aria-label="Tags"
          {...away(menu === "tags" && !run)}
        >
          <div className={s.seg}>
            <span
              className={s.knob}
              style={{ transform: tagOp === "add" ? "translateX(0)" : "translateX(100%)" }}
            />
            <button type="button" aria-pressed={tagOp === "add"} onClick={() => setTagOp("add")}>
              Add a tag
            </button>
            <button type="button" aria-pressed={tagOp === "remove"} onClick={() => setTagOp("remove")}>
              Remove a tag
            </button>
          </div>
          {catalog.tags.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={pick === t.id}
              className={s.io}
              onClick={() => setPick(t.id)}
            >
              {t.label}
              {Ico.tick}
            </button>
          ))}
          <div className={`${s.go} ${pick ? s.goOn : ""}`} {...away(!!pick)}>
            <div>
              <div className={s.goIn}>
                {error && (
                  <div className={s.err} role="alert">
                    {error}
                  </div>
                )}
                <button
                  type="button"
                  className={s.commit}
                  disabled={busy}
                  onClick={() => pick && void start({ type: "tags", [tagOp]: [pick] })}
                >
                  {tagOp === "add"
                    ? `Add “${pickedName(catalog.tags)}” to ${fmt(n)}`
                    : `Remove “${pickedName(catalog.tags)}” from ${fmt(n)}`}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div
          className={`${s.pane} ${menu === "more" && !run ? s.paneOn : ""}`}
          role="menu"
          data-pane="more"
          aria-label="More"
          {...away(menu === "more" && !run)}
        >
          {more === "list" && (
            <>
              <div className={s.ph}>
                <span>More for {fmt(n)}</span>
              </div>
              {phoneFixable && can(actor, "leads.edit") && (
                <button type="button" className={s.io} onClick={() => setMore("phone")}>
                  Read phone numbers with a country…
                </button>
              )}
              {can(actor, "leads.delete") && (
                <button type="button" className={`${s.io} ${s.danger}`} onClick={() => setMore("delete")}>
                  Delete {leadsWord(n)}…
                </button>
              )}
            </>
          )}
          {more === "phone" && (
            <>
              <div className={s.ph}>
                <span>Read their numbers as</span>
              </div>
              <div style={{ padding: "0 8px" }}>
                <CountryPicker label="Country" value={country} onChange={setCountry} />
              </div>
              <div className={`${s.go} ${s.goOn}`}>
                <div>
                  <div className={s.goIn}>
                    {error && (
                      <div className={s.err} role="alert">
                        {error}
                      </div>
                    )}
                    <button
                      type="button"
                      className={s.commit}
                      disabled={busy || !country}
                      onClick={() => void start({ type: "set_phone_country", country })}
                    >
                      Read {fmt(n)} with this country
                    </button>
                    <div className={s.note}>Numbers LUME can already read stay as they are.</div>
                  </div>
                </div>
              </div>
            </>
          )}
          {more === "delete" && (
            <>
              <div className={s.ph}>
                <span>Delete {leadsWord(n)}?</span>
              </div>
              <p
                style={{
                  margin: 0,
                  padding: "0 10px",
                  fontSize: "var(--fs-md)",
                  lineHeight: 1.5,
                  color: "rgba(255,255,255,.85)",
                }}
              >
                They leave every list and count. You can undo this for 24 hours, from here or from Recent bulk
                actions.
              </p>
              {error && (
                <div className={s.err} role="alert">
                  {error}
                </div>
              )}
              <div className={`${s.go} ${s.goOn}`}>
                <div>
                  <div className={s.goIn} style={{ flexDirection: "row" }}>
                    <button
                      type="button"
                      className={`${s.commit} ${s.quiet}`}
                      style={{ flex: 1 }}
                      onClick={() => setMenu(null)}
                    >
                      Keep them
                    </button>
                    <button
                      type="button"
                      className={`${s.commit} ${s.red}`}
                      style={{ flex: 1 }}
                      disabled={busy}
                      onClick={() => void start({ type: "delete" })}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div
          className={`${s.pane} ${s.paneTall} ${finished && why ? s.paneOn : ""}`}
          role="dialog"
          aria-label="Why some were skipped"
          {...away(!!(finished && why))}
        >
          <div className={s.ph}>
            <span>{undoing ? "What LUME left as it was" : `Why LUME skipped ${fmt(run?.skipped ?? 0)}`}</span>
          </div>
          {skippedBy.map(([code, c]) => (
            <div key={code} className={s.reason}>
              <b>{fmt(c)}</b>
              <span>{reasonWords(code, c).replace(/^\S+\s/, "")}.</span>
            </div>
          ))}
        </div>

        {/* 1 · what's selected */}
        <div
          className={`${s.lay} ${s.row} ${!run ? s.layOn : ""}`}
          role="toolbar"
          aria-label="Bulk actions"
          {...away(!run)}
        >
          <div className={s.count} aria-live="polite">
            <b>{fmt(n)}</b>
            <span>selected{allMatching ? ", all that match" : ""}</span>
          </div>
          <span className={s.vr} aria-hidden />
          {bulk && can(actor, "leads.change_stage") && (
            <button
              ref={(el) => {
                triggers.current.stage = el;
              }}
              type="button"
              className={s.ia}
              aria-haspopup="menu"
              aria-expanded={menu === "stage"}
              onClick={() => open("stage")}
            >
              {Ico.stage}Move to
            </button>
          )}
          {bulk && can(actor, "leads.assign") && (
            <button
              ref={(el) => {
                triggers.current.assign = el;
              }}
              type="button"
              className={s.ia}
              aria-haspopup="menu"
              aria-expanded={menu === "assign"}
              onClick={() => open("assign")}
            >
              {Ico.assign}Assign
            </button>
          )}
          {bulk && catalog.tags.length > 0 && can(actor, "leads.edit") && (
            <button
              ref={(el) => {
                triggers.current.tags = el;
              }}
              type="button"
              className={s.ia}
              aria-haspopup="menu"
              aria-expanded={menu === "tags"}
              onClick={() => open("tags")}
            >
              {Ico.tag}Tags
            </button>
          )}
          {can(actor, "messages.send_queue") && !allMatching && leadIds.length > 0 && (
            <StartRun source={{ leadIds }} label="Message" triggerClassName={s.ia} side="auto" />
          )}
          {bulk && (can(actor, "leads.delete") || (phoneFixable && can(actor, "leads.edit"))) && (
            <button
              ref={(el) => {
                triggers.current.more = el;
              }}
              type="button"
              className={`${s.ia} ${s.icon}`}
              aria-label="More bulk actions"
              aria-haspopup="menu"
              aria-expanded={menu === "more"}
              onClick={() => open("more")}
            >
              {Ico.more}
            </button>
          )}
          <span className={s.spacer} />
          <button type="button" className={`${s.ia} ${s.icon}`} aria-label="Clear selection" onClick={close}>
            {Ico.close}
          </button>
        </div>

        {/* 2 · running */}
        <div className={`${s.lay} ${s.big} ${live ? s.layOn : ""}`} {...away(!!live)}>
          <div
            className={s.ring}
            ref={runningRef}
            tabIndex={-1}
            role="progressbar"
            aria-label={run && live ? runLine(run, name) : "Progress"}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={processed}
          >
            <svg viewBox="0 0 38 38" aria-hidden>
              <circle className={s.ringBg} cx="19" cy="19" r="16" />
              <circle
                className={s.ringFg}
                cx="19"
                cy="19"
                r="16"
                style={{ strokeDashoffset: 101 - 101 * (undoing ? 1 - fill : fill) }}
              />
            </svg>
            <b>{Math.round(p * 100)}%</b>
          </div>
          <div className={s.rtx}>
            <span>{run && live ? runLine(run, name) : ""}</span>
            <b>
              <span>{fmt(run?.done ?? 0)}</span>
              <small>of {fmt(total)}</small>
            </b>
          </div>
          <span className={s.eta}>
            {run?.status === "queued"
              ? "Starting…"
              : `About ${Math.max(1, Math.round(((total - processed) / 500) * 1.2))} s left`}
            <br />
            <span style={{ opacity: 0.7 }}>
              Batch {batch} of {chunks}
            </span>
          </span>
          {!undoing && (
            <button
              type="button"
              className={s.ib}
              title="Keep working. LUME will let you know when it’s done."
              onClick={() => setTucked(true)}
            >
              {Ico.hide}Hide
            </button>
          )}
          {!undoing && (
            <button type="button" className={s.ib} ref={stopRef} onClick={() => void stop()}>
              Stop
            </button>
          )}
        </div>

        {/* 3 · finished */}
        <div className={`${s.lay} ${s.big} ${finished ? s.layOn : ""}`} {...away(!!finished)}>
          <span
            className={`${s.okc} ${run?.status === "cancelled" || run?.status === "failed" ? s.stop : ""} ${undoing ? s.back : ""}`}
          >
            {undoing ? Ico.undo : Ico.check}
          </span>
          <div className={s.dtx}>
            <b>{finishedTitle()}</b>
            <span>
              {finishedSub()}
              {(run?.skipped ?? 0) > 0 && (
                <>
                  {" ·"}
                  <button
                    type="button"
                    className={s.why}
                    aria-expanded={why}
                    onClick={() => setWhy((x) => !x)}
                  >
                    {undoing ? `${fmt(run!.skipped)} changed since` : `${fmt(run!.skipped)} skipped`}
                  </button>
                </>
              )}
            </span>
          </div>
          <div className={s.end}>
            {run?.canUndo && (
              <button
                type="button"
                className={`${s.ib} ${s.solid}`}
                ref={undoRef}
                onClick={() => void undo()}
              >
                {Ico.undo}
                {run.status === "done" ? "Undo" : `Undo these ${fmt(run.done)}`}
              </button>
            )}
            <button
              type="button"
              className={`${s.ia} ${s.icon}`}
              aria-label="Close"
              ref={closeRef}
              onClick={close}
            >
              {Ico.close}
            </button>
          </div>
        </div>
      </div>

      <p className={s.sr} aria-live="polite" aria-atomic="true">
        {said}
      </p>
      {tucked &&
        run &&
        slot &&
        createPortal(
          <button
            type="button"
            className={s.mini}
            ref={miniRef}
            onClick={() => setTucked(false)}
            aria-label="Show the bulk action"
          >
            {live ? (
              <svg className={s.miniRing} viewBox="0 0 22 22" aria-hidden>
                <circle className={s.miniBg} cx="11" cy="11" r="9" />
                <circle
                  className={s.miniFg}
                  cx="11"
                  cy="11"
                  r="9"
                  style={{ strokeDashoffset: 57 - 57 * p }}
                />
              </svg>
            ) : (
              <span className={s.miniOk}>{Ico.check}</span>
            )}
            <span>
              {live ? `${runLine(run, name).split(" ")[0]} · ${Math.round(p * 100)}%` : finishedTitle()}
            </span>
          </button>,
          slot,
        )}
    </>
  );
}
