"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useSound } from "@/components/feedback/SoundProvider";
import { useToast } from "@/components/feedback/ToastProvider";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Popover } from "@/components/ui/Popover";
import { Skeleton } from "@/components/ui/Skeleton";
import { leadsClient } from "@/lib/leads/client";
import { formatMoney, personName, relativeTime } from "@/lib/leads/format";
import { SPRINGS, toMotion } from "@/lib/motion";
import type { Activity, FieldDefView, Lead, Stage } from "@/lib/leads/types";
import type { Session } from "@/server/session";
import { useCatalog } from "../CatalogProvider";
import { EditableCell } from "../EditableCell";
import { FieldValue } from "../fields/FieldValue";
import { editable, useLeadEditor } from "../useLeadEditor";
import { useStageMove } from "../useStageMove";
import { AssignMenu } from "./AssignMenu";
import { ContactBox } from "./ContactBox";
import { MessageButton } from "./MessageButton";
import { PetalBurst } from "./PetalBurst";
import { StageTrack } from "./StageTrack";
import { NoteComposer, Timeline } from "./Timeline";
import { WonPopover, type WonChange } from "./WonPopover";
import s from "./drawer.module.css";

export type GoneReason = "handed" | "deleted";
type Props = {
  id: string;
  session: Session;
  /** The ids of the rows in the list behind, in order, for "n of m" and J/K. */
  neighbours: string[];
  onClose: () => void;
  onStep: (id: string) => void;
  onChanged: (lead: Lead) => void;
  onGone: (id: string, why: GoneReason) => void;
};
type Tab = "details" | "notes" | "history";
const TABS: { id: Tab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "notes", label: "Notes" },
  { id: "history", label: "History" },
];
/** Left out of the field list: shown in their own places (header, owner menu, stage track, contact box). */
const SHOWN_ELSEWHERE = new Set(["name", "phone", "email", "instagram", "owner", "stage"]);
const FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const typingIn = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** The activity feed behind Notes and History, fetched when either tab opens so it's never stale. */
function useActivities(id: string) {
  const [items, setItems] = useState<Activity[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const current = useRef(id);
  current.current = id;

  const load = useCallback(
    async (after?: string) => {
      const forId = id;
      const r = await leadsClient.activities(forId, after);
      if (current.current !== forId || !r.ok) return;
      setItems((prev) =>
        after ? [...prev, ...r.data.items.filter((a) => !prev.some((p) => p.id === a.id))] : r.data.items,
      );
      setCursor(r.data.nextCursor);
      setLoaded(true);
    },
    [id],
  );
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setLoaded(false);
  }, [id]);

  return {
    items,
    loaded,
    hasMore: cursor !== null,
    reload: () => void load(),
    more: () => cursor && void load(cursor),
    prepend: (a: Activity) => setItems((prev) => [a, ...prev]),
  };
}

/**
 * The lead drawer (the approved prototype's `.drawer`): everything about one lead, and everything you
 * can do with it, without leaving the list. It slides in from the right and leaves the same way.
 */
export function LeadDrawer({ id, session, neighbours, onClose, onStep, onChanged, onGone }: Props) {
  const catalog = useCatalog();
  const { toast } = useToast();
  const sound = useSound();
  const reduce = useReducedMotion();
  const [lead, setLead] = useState<Lead | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "gone">("loading");
  const [tab, setTab] = useState<Tab>("details");
  const [burst, setBurst] = useState<{ x: number; y: number } | null>(null);
  const activities = useActivities(id);
  const move = useStageMove();
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const wonAnchor = useRef<HTMLSpanElement>(null);
  const headingId = useId();
  const tabsId = useId();

  // Load (and re-load on J/K). An answer for a lead that is no longer shown is dropped.
  useEffect(() => {
    let live = true;
    setState("loading");
    void leadsClient.get(id).then((r) => {
      if (!live) return;
      if (r.ok) {
        setLead(r.data.lead);
        setState("ready");
      } else {
        setLead(null);
        setState("gone");
      }
    });
    return () => {
      live = false;
    };
  }, [id]);

  const changed = useCallback(
    (next: Lead) => {
      setLead(next);
      onChanged(next);
    },
    [onChanged],
  );
  const editor = useLeadEditor(changed);
  const { reload: reloadActivities } = activities;
  const logged = useCallback(() => {
    if (tab !== "details") reloadActivities();
  }, [tab, reloadActivities]);

  // Focus moves to the name when the drawer opens and goes back where it came from when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  useEffect(() => {
    if (state !== "loading") (heading.current ?? panel.current)?.focus();
  }, [state, id]);

  const index = neighbours.indexOf(id);
  const step = useCallback(
    (by: 1 | -1) => {
      const next = index === -1 ? undefined : neighbours[index + by];
      if (next) onStep(next);
    },
    [index, neighbours, onStep],
  );

  // J/K/W/N and Escape, only when the person isn't typing and no question is open over the drawer.
  const asking = move.ui !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // In a field, Escape belongs to the field (it cancels an edit), and letters are just typing.
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || asking || typingIn(e.target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        return onClose();
      }
      const key = e.key.toLowerCase();
      if (key === "j") step(1);
      else if (key === "k") step(-1);
      else if (key === "w")
        panel.current
          ?.querySelector<HTMLButtonElement>("[data-whatsapp] button[aria-haspopup]:not(:disabled)")
          ?.click();
      else if (key === "n") {
        setTab("notes");
        requestAnimationFrame(() =>
          panel.current?.querySelector<HTMLTextAreaElement>("[data-note-input]")?.focus(),
        );
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking, onClose, step]);

  // Tab stays inside the drawer.
  const trap = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const openTab = (t: Tab) => {
    setTab(t);
    if (t !== "details") reloadActivities();
  };

  const pipeline = lead ? catalog.pipelines.find((p) => p.id === lead.pipelineId) : undefined;
  const stage = pipeline?.stages.find((st) => st.id === lead?.stageId);
  const wonStage = pipeline?.stages.find((st) => st.kind === "won");
  const lostStage = pipeline?.stages.find((st) => st.kind === "lost");

  const moveTo = async (target: Stage) => {
    if (!lead) return;
    const moved = await move.request(lead, target);
    if (moved) {
      changed(moved);
      logged();
    }
  };

  const markWon = async (change: WonChange) => {
    if (!lead || !wonStage) return;
    let current = lead;
    if (Object.keys(change).length) {
      const saved = await leadsClient.patch(lead.id, lead.version, change);
      if (!saved.ok) {
        toast({
          tone: "danger",
          title:
            saved.status === 409
              ? `${lead.name ?? "This lead"} was changed by someone else`
              : "The deal value didn’t save",
          detail: saved.status === 409 ? "Close this and try again." : saved.message,
        });
        return;
      }
      current = saved.data.lead;
      changed(current);
    }
    const moved = await move.request(current, wonStage);
    if (!moved) return;
    changed(moved);
    logged();
    sound.play("won");
    const r = wonAnchor.current?.getBoundingClientRect();
    if (r && !reduce) setBurst({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    toast({
      tone: "ok",
      title: moved.value ? `Won · ${formatMoney(moved.value, catalog.currency)}` : "Won",
      detail: moved.name,
    });
  };

  const assign = async (ownerId: string | null) => {
    if (!lead) return;
    const who = personName(catalog, ownerId);
    const r = await leadsClient.assign(lead.id, ownerId);
    if (!r.ok)
      return toast({
        tone: "danger",
        title: `Couldn’t hand ${lead.name ?? "this lead"} over`,
        detail: r.message,
      });
    const title = ownerId ? `Handed to ${who}` : "Now unassigned";
    if (!r.data.visible) {
      toast({ tone: "ok", title, detail: "It’s no longer in your list." });
      return onGone(lead.id, "handed");
    }
    toast({ tone: "ok", title });
    const fresh = await leadsClient.get(lead.id);
    changed(fresh.ok ? fresh.data.lead : { ...lead, ownerId });
    logged();
  };

  const remove = async () => {
    if (!lead) return;
    const r = await leadsClient.remove(lead.id);
    if (!r.ok)
      return toast({
        tone: "danger",
        title: `Couldn’t delete ${lead.name ?? "this lead"}`,
        detail: r.message,
      });
    toast({ title: `Deleted ${lead.name ?? "the lead"}` });
    onGone(lead.id, "deleted");
  };

  const addNote = async (body: string) => {
    if (!lead) return false;
    const r = await leadsClient.note(lead.id, body);
    if (!r.ok) {
      toast({ tone: "danger", title: "That note didn’t save", detail: r.message });
      return false;
    }
    activities.prepend(r.data.activity);
    return true;
  };

  const nameDef = catalog.fields.find((f) => f.key === "name");
  const detailFields = catalog.fields.filter(
    (f) => !f.archived && f.access !== "hidden" && !SHOWN_ELSEWHERE.has(f.key),
  );
  const fieldRow = (def: FieldDefView) =>
    lead && (
      <div key={def.id} className={s.fieldRow}>
        <dt>{def.label}</dt>
        <dd>
          {editable(lead, def) ? (
            <EditableCell
              lead={lead}
              def={def}
              save={editor.save}
              error={
                editor.error?.leadId === lead.id && editor.error.key === def.key ? editor.error.message : null
              }
              onDismissError={editor.clearError}
            >
              <FieldValue lead={lead} def={def} />
            </EditableCell>
          ) : (
            <FieldValue lead={lead} def={def} />
          )}
        </dd>
      </div>
    );

  const notes = activities.items.filter((a) => a.type === "note");
  const history = activities.items.filter((a) => a.type !== "note");
  const title = lead?.name ?? (state === "gone" ? "Lead not available" : "Loading lead");

  return (
    <>
      <motion.div
        className={s.scrim}
        onClick={onClose}
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className={s.drawer}
        onKeyDown={trap}
        // The resting state names both properties: the server can't know the motion preference, so a
        // drawer rendered there may start off-screen even for someone who then gets the fade.
        initial={reduce ? { opacity: 0, x: 0 } : { opacity: 1, x: "calc(100% + 24px)" }}
        animate={{ opacity: 1, x: 0 }}
        exit={reduce ? { opacity: 0, x: 0 } : { opacity: 1, x: "calc(100% + 24px)" }}
        transition={toMotion(SPRINGS.drawer)}
      >
        <div className={s.top}>
          <IconButton label="Close (Esc)" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </IconButton>
          <IconButton label="Previous lead (K)" disabled={index <= 0} onClick={() => step(-1)}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path
                d="M4 10l4-4 4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </IconButton>
          <IconButton
            label="Next lead (J)"
            disabled={index === -1 || index >= neighbours.length - 1}
            onClick={() => step(1)}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </IconButton>
          {index !== -1 && (
            <span className={s.position}>
              {index + 1} of {neighbours.length}
            </span>
          )}
          {lead?.can.delete && (
            <div className={s.topEnd}>
              <Popover
                label="Delete lead"
                align="end"
                triggerClassName={s.deleteBtn}
                trigger={
                  <>
                    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
                      <path
                        d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className={s.srOnly}>Delete lead</span>
                  </>
                }
              >
                {(close) => (
                  <div className={s.popForm}>
                    <p className={s.popTitle}>Delete {lead.name ?? "this lead"}?</p>
                    <p className={s.popSub}>This can’t be undone from here.</p>
                    <div className={s.popActions}>
                      <Button size="sm" variant="ghost" onClick={close}>
                        Cancel
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => void remove()}>
                        Delete
                      </Button>
                    </div>
                  </div>
                )}
              </Popover>
            </div>
          )}
        </div>

        <div className={s.scroll}>
          {state === "loading" && (
            <div className={s.skeleton} aria-busy="true">
              <h2 id={headingId} className={s.srOnly}>
                {title}
              </h2>
              <div className={s.head}>
                <Skeleton width={52} height={52} radius={26} />
                <div className={s.skLines}>
                  <Skeleton width={180} height={20} />
                  <Skeleton width={140} height={12} />
                </div>
              </div>
              <Skeleton height={36} radius={10} />
              <Skeleton height={6} radius={99} />
              <Skeleton height={120} radius={14} />
            </div>
          )}

          {state === "gone" && (
            <div className={s.gone}>
              <h2 id={headingId} ref={heading} tabIndex={-1}>
                This lead isn’t available to you any more
              </h2>
              <p>It may have been handed to someone else or deleted.</p>
              <Button onClick={onClose}>Close</Button>
            </div>
          )}

          {state === "ready" && lead && (
            <>
              <header className={s.head}>
                <Avatar name={lead.name ?? "?"} size={52} />
                <div className={s.headText}>
                  {nameDef && editable(lead, nameDef) ? (
                    <EditableCell
                      lead={lead}
                      def={nameDef}
                      save={editor.save}
                      error={
                        editor.error?.leadId === lead.id && editor.error.key === "name"
                          ? editor.error.message
                          : null
                      }
                      onDismissError={editor.clearError}
                    >
                      <h2 id={headingId} ref={heading} tabIndex={-1} className={s.name}>
                        {title}
                      </h2>
                    </EditableCell>
                  ) : (
                    <h2 id={headingId} ref={heading} tabIndex={-1} className={s.name}>
                      {title}
                    </h2>
                  )}
                  <div className={s.sub}>
                    <span data-volatile>Enquiry {relativeTime(lead.leadCreatedAt ?? lead.createdAt)}</span>
                    <span aria-hidden> · </span>
                    <AssignMenu
                      lead={lead}
                      catalog={catalog}
                      session={session}
                      onAssign={(o) => void assign(o)}
                    />
                  </div>
                </div>
              </header>

              <div className={s.actions}>
                {lead.can.message && <MessageButton lead={lead} onLogged={logged} />}
                {lead.can.move && (
                  <div className={s.outcomes}>
                    {wonStage && stage?.kind !== "won" && (
                      <span ref={wonAnchor}>
                        <WonPopover lead={lead} catalog={catalog} onConfirm={markWon} />
                      </span>
                    )}
                    {lostStage && stage?.kind !== "lost" && (
                      <button type="button" className={s.lostBtn} onClick={() => void moveTo(lostStage)}>
                        Lost
                      </button>
                    )}
                  </div>
                )}
              </div>

              <StageTrack
                lead={lead}
                catalog={catalog}
                canMove={lead.can.move}
                onMove={(st) => void moveTo(st)}
              />

              <div role="tablist" aria-label="Lead" className={s.tabs}>
                {TABS.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`${tabsId}-${t.id}`}
                    aria-selected={tab === t.id}
                    aria-controls={`${tabsId}-${t.id}-panel`}
                    tabIndex={tab === t.id ? 0 : -1}
                    className={s.tab}
                    onClick={() => openTab(t.id)}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                      e.preventDefault();
                      const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
                      openTab(next.id);
                      document.getElementById(`${tabsId}-${next.id}`)?.focus();
                    }}
                  >
                    {t.label}
                    {tab === t.id && (
                      <motion.span
                        layoutId={`${tabsId}-ink`}
                        className={s.tabInk}
                        transition={toMotion(SPRINGS.default)}
                      />
                    )}
                  </button>
                ))}
              </div>

              <div
                role="tabpanel"
                id={`${tabsId}-${tab}-panel`}
                aria-labelledby={`${tabsId}-${tab}`}
                className={s.panel}
              >
                {tab === "details" && (
                  <div className={s.boxes}>
                    <ContactBox key={lead.id} lead={lead} onRevealed={logged} />
                    {detailFields.length > 0 && (
                      <section className={s.box} aria-label="Details">
                        <h3 className={s.boxTitle}>Details</h3>
                        <dl className={s.fields}>{detailFields.map(fieldRow)}</dl>
                      </section>
                    )}
                  </div>
                )}
                {tab === "notes" && (
                  <>
                    <NoteComposer onAdd={addNote} disabled={!lead.can.edit} />
                    <Timeline
                      items={notes}
                      catalog={catalog}
                      hasMore={activities.hasMore}
                      onMore={activities.more}
                      empty={activities.loaded ? "No notes yet" : "Loading…"}
                    />
                  </>
                )}
                {tab === "history" && (
                  <Timeline
                    items={history}
                    catalog={catalog}
                    hasMore={activities.hasMore}
                    onMore={activities.more}
                    empty={activities.loaded ? "Nothing has happened yet" : "Loading…"}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </motion.div>
      {move.ui}
      <AnimatePresence>{burst && <PetalBurst at={burst} onDone={() => setBurst(null)} />}</AnimatePresence>
    </>
  );
}
