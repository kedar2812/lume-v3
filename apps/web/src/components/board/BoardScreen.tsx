"use client";
import { AnimatePresence, LayoutGroup, motion, useMotionValue, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { can, seesFullContacts } from "@lume/core/shared";
import { useSound } from "@/components/feedback/SoundProvider";
import { useToast } from "@/components/feedback/ToastProvider";
import { CatalogProvider } from "@/components/leads/CatalogProvider";
import { LeadDrawer } from "@/components/leads/drawer/LeadDrawer";
import { FilterBar } from "@/components/leads/FilterBar";
import { NewLeadSheet } from "@/components/leads/NewLeadSheet";
import { useStageMove } from "@/components/leads/useStageMove";
import l from "@/components/leads/leads.module.css";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { leadsClient } from "@/lib/leads/client";
import { BOARD_PAGE, filtersToParams, type ListFilters } from "@/lib/leads/filters";
import { formatMoney } from "@/lib/leads/format";
import type { Catalog, Lead, LeadPage, Pipeline, Stage } from "@/lib/leads/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import type { Session } from "@/server/session";
import { BoardCard, CardFace } from "./BoardCard";
import { BoardColumn } from "./BoardColumn";
import { boardKeys, type BoardKeysState } from "./boardKeys";
import s from "./board.module.css";

type Props = {
  session: Session;
  catalog: Catalog;
  pipeline: Pipeline;
  filters: ListFilters;
  /** The first cards of each stage, by stage id. */
  columns: Record<string, LeadPage>;
  counts: Record<string, number>;
  initialLeadId?: string | null;
};
type Drag = { lead: Lead; from: Stage; width: number; dx: number; dy: number; over: string | null };

const EMPTY: LeadPage = { items: [], nextCursor: null };
const DRAG_THRESHOLD = 6;
const EDGE = 64;

const without = (p: LeadPage | undefined, id: string): LeadPage => ({
  ...(p ?? EMPTY),
  items: (p?.items ?? []).filter((x) => x.id !== id),
});
const insertAt = (p: LeadPage | undefined, lead: Lead, index = 0): LeadPage => {
  const items = (p?.items ?? []).filter((x) => x.id !== lead.id);
  items.splice(Math.max(0, Math.min(index, items.length)), 0, lead);
  return { ...(p ?? EMPTY), items };
};
const replaceIn = (p: LeadPage | undefined, lead: Lead): LeadPage => ({
  ...(p ?? EMPTY),
  items: (p?.items ?? []).map((x) => (x.id === lead.id ? lead : x)),
});
const nameOf = (lead: Lead) => lead.name ?? "This lead";

/** The pipeline board. The catalog is provided around it, like the table. */
export function BoardScreen(props: Props) {
  return (
    <CatalogProvider catalog={props.catalog}>
      <Board {...props} />
    </CatalogProvider>
  );
}

function Board({
  session,
  catalog,
  pipeline,
  filters: initialFilters,
  columns: firstColumns,
  counts: firstCounts,
  initialLeadId = null,
}: Props) {
  const stages = useMemo(() => [...pipeline.stages].sort((a, b) => a.position - b.position), [pipeline]);
  const [filters, setFilters] = useState(initialFilters);
  const [columns, setColumns] = useState(firstColumns);
  const [counts, setCounts] = useState(firstCounts);
  const [keys, setKeys] = useState<BoardKeysState>({ picked: null });
  const [message, setMessage] = useState("");
  const [openId, setOpenId] = useState<string | null>(initialLeadId);
  const [creating, setCreating] = useState(false);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const { request, ui } = useStageMove();
  const sound = useSound();
  const { toast } = useToast();
  const router = useRouter();
  const reduce = useReducedMotion();
  const board = useRef<HTMLDivElement>(null);
  const liftX = useMotionValue(0);
  const liftY = useMotionValue(0);
  const mayCreate = can(session.actor, "leads.create");
  const contactsVisible = seesFullContacts(session.actor);

  const keysRef = useRef(keys);
  keysRef.current = keys;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const findLead = useCallback(
    (id: string) => {
      for (const stage of stages) {
        const lead = columnsRef.current[stage.id]?.items.find((x) => x.id === id);
        if (lead) return { lead, stage };
      }
      return null;
    },
    [stages],
  );
  const focusCard = (id: string) =>
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-lead-card="${id}"]`)?.focus());
  const shift = (lead: Lead, from: string, to: string, index = 0) => {
    setColumns((c) => ({ ...c, [from]: without(c[from], lead.id), [to]: insertAt(c[to], lead, index) }));
    setCounts((n) => ({ ...n, [from]: Math.max(0, (n[from] ?? 1) - 1), [to]: (n[to] ?? 0) + 1 }));
  };

  /** Every move on the board, by pointer or keyboard: it lands at once, and springs back if refused. */
  const move = async (lead: Lead, from: Stage, to: Stage) => {
    if (from.id === to.id) return setMessage(`${nameOf(lead)} stayed in ${from.name}.`);
    const index = columnsRef.current[from.id]?.items.findIndex((x) => x.id === lead.id) ?? 0;
    shift(lead, from.id, to.id);
    const moved = await request(lead, to); // lost reasons, required fields and refusals are asked or explained there
    if (!moved) {
      shift(lead, to.id, from.id, index);
      setMessage(`${nameOf(lead)} stayed in ${from.name}.`);
      return focusCard(lead.id);
    }
    setColumns((c) => ({ ...c, [to.id]: replaceIn(c[to.id], moved) }));
    if (to.kind === "won") {
      sound.play("won");
      toast({
        tone: "ok",
        title: `Won · ${nameOf(moved)}`,
        detail: moved.value ? formatMoney(moved.value, moved.currency ?? catalog.currency) : undefined,
      });
    }
    setMessage(`${nameOf(lead)} moved to ${to.name}.`);
    focusCard(lead.id);
  };
  const moveRef = useRef(move);
  moveRef.current = move;

  // ── keyboard ──
  const drop = () => {
    const p = keysRef.current.picked;
    if (!p) return;
    setKeys({ picked: null });
    const found = findLead(p.leadId);
    const from = stages[p.from];
    const to = stages[p.to];
    if (found && from && to) void move(found.lead, from, to);
  };
  const roam = (e: KeyboardEvent<HTMLButtonElement>) => {
    const card = e.currentTarget;
    const column = card.closest<HTMLElement>("[data-stage-id]");
    if (!column) return;
    const inColumn = [...column.querySelectorAll<HTMLElement>("[data-lead-card]")];
    const at = inColumn.indexOf(card);
    let target: HTMLElement | undefined;
    if (e.key === "ArrowDown") target = inColumn[at + 1];
    else if (e.key === "ArrowUp") target = inColumn[at - 1];
    else {
      const all = [...(board.current?.querySelectorAll<HTMLElement>("[data-stage-id]") ?? [])];
      const step = e.key === "ArrowRight" ? 1 : -1;
      for (let i = all.indexOf(column) + step; i >= 0 && i < all.length; i += step) {
        const cards = all[i]!.querySelectorAll<HTMLElement>("[data-lead-card]");
        target = cards[Math.min(at, cards.length - 1)];
        if (target) break;
      }
    }
    if (target) {
      e.preventDefault();
      target.focus();
    }
  };
  const onCardKey = (lead: Lead, stage: Stage) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const picked = keysRef.current.picked;
    const mine = picked?.leadId === lead.id;
    if (e.key === " ") {
      e.preventDefault();
      if (!lead.can.move) return;
      if (mine) return drop();
      const next = boardKeys(keysRef.current, {
        type: "pick",
        leadId: lead.id,
        column: stages.indexOf(stage),
      });
      keysRef.current = next;
      setKeys(next);
      return setMessage(
        `Picked up ${nameOf(lead)}. Left and right arrows choose a stage, Enter drops, Escape cancels.`,
      );
    }
    if (mine) {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const next = boardKeys(
          keysRef.current,
          e.key === "ArrowRight" ? { type: "right", columns: stages.length } : { type: "left" },
        );
        keysRef.current = next;
        setKeys(next);
        return setMessage(`Over ${stages[next.picked!.to]!.name}.`);
      }
      if (e.key === "Enter") {
        e.preventDefault();
        return drop();
      }
      if (e.key === "Escape" || e.key === "Tab") {
        if (e.key === "Escape") e.preventDefault();
        e.stopPropagation();
        setKeys({ picked: null });
        return setMessage(`${nameOf(lead)} put back in ${stage.name}.`);
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
      return;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) roam(e);
  };

  // ── pointer drag: a lifted copy follows the pointer; the card waits, dimmed, in its place ──
  const pending = useRef<{ lead: Lead; stage: Stage; x: number; y: number; rect: DOMRect } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  const onCardPointerDown = (lead: Lead, stage: Stage) => (e: PointerEvent<HTMLButtonElement>) => {
    // Touch keeps scrolling the board; on a phone a lead moves from its drawer or the keyboard.
    if (e.button !== 0 || e.pointerType === "touch" || !lead.can.move || keysRef.current.picked) return;
    pending.current = {
      lead,
      stage,
      x: e.clientX,
      y: e.clientY,
      rect: e.currentTarget.getBoundingClientRect(),
    };
  };
  useEffect(() => {
    const setOver = (over: string | null) => {
      if (!dragRef.current || dragRef.current.over === over) return;
      dragRef.current = { ...dragRef.current, over };
      setDrag(dragRef.current);
    };
    const onMove = (e: globalThis.PointerEvent) => {
      const p = pending.current;
      if (!p) return;
      if (!dragRef.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
        dragRef.current = {
          lead: p.lead,
          from: p.stage,
          width: p.rect.width,
          dx: p.x - p.rect.left,
          dy: p.y - p.rect.top,
          over: p.stage.id,
        };
        setDrag(dragRef.current);
      }
      const d = dragRef.current;
      liftX.set(e.clientX - d.dx);
      liftY.set(e.clientY - d.dy);
      const column = document
        .elementsFromPoint(e.clientX, e.clientY)
        .find((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.stageId);
      setOver(column?.dataset.stageId ?? null);
      // Near an edge, the board scrolls to reveal the stages beyond it.
      const b = board.current?.getBoundingClientRect();
      if (b && board.current) {
        if (e.clientX > b.right - EDGE) board.current.scrollLeft += 14;
        else if (e.clientX < b.left + EDGE) board.current.scrollLeft -= 14;
      }
    };
    const finish = (commit: boolean) => {
      pending.current = null;
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      swallowClick.current = true;
      setTimeout(() => (swallowClick.current = false), 0);
      setDrag(null);
      const to = stages.find((st) => st.id === d.over);
      if (commit && to && to.id !== d.from.id) void moveRef.current(d.lead, d.from, to);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current) {
        e.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [stages, liftX, liftY]);

  // ── filters: the whole board refetches, and an answer to an older filter is dropped ──
  const generation = useRef(0);
  const firstRun = useRef(true);
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const gen = ++generation.current;
    const f: ListFilters = { ...filters, stageIds: [], pipelineId: pipeline.id };
    const t = setTimeout(
      async () => {
        const [c, ...pages] = await Promise.all([
          leadsClient.counts({ ...f, pipelineId: pipeline.id }),
          ...stages.map((st) => leadsClient.list({ ...f, stageIds: [st.id] }, undefined, BOARD_PAGE)),
        ]);
        if (gen !== generation.current) return;
        if (!c || !c.ok || pages.some((p) => !p.ok)) return setFailed(true);
        setFailed(false);
        setCounts(c.data.counts);
        setColumns(Object.fromEntries(stages.map((st, i) => [st.id, pages[i]!.ok ? pages[i]!.data : EMPTY])));
      },
      filters.q ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [filters, stages, pipeline.id, reloadTick]);

  // The address bar mirrors the filters, the pipeline and the open lead.
  useEffect(() => {
    const p = filtersToParams({ ...filters, stageIds: [], pipelineId: undefined });
    if (!pipeline.isDefault) p.set("pipeline", pipeline.id);
    if (openId) p.set("lead", openId);
    const qs = p.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (url !== window.location.pathname + window.location.search) window.history.replaceState(null, "", url);
  }, [filters, pipeline, openId]);

  const loadMore = async (stage: Stage) => {
    const cursor = columnsRef.current[stage.id]?.nextCursor;
    if (!cursor) return;
    setLoadingMore(stage.id);
    const r = await leadsClient.list(
      { ...filters, stageIds: [stage.id], pipelineId: pipeline.id },
      cursor,
      BOARD_PAGE,
    );
    setLoadingMore(null);
    if (!r.ok) return toast({ tone: "danger", title: "LUME couldn’t load more leads", detail: r.message });
    setColumns((c) => {
      const have = c[stage.id] ?? EMPTY;
      return {
        ...c,
        [stage.id]: {
          items: [...have.items, ...r.data.items.filter((x) => !have.items.some((h) => h.id === x.id))],
          nextCursor: r.data.nextCursor,
        },
      };
    });
  };

  // ── the drawer over the board ──
  const onChanged = (lead: Lead) => {
    const found = findLead(lead.id);
    if (!found) return;
    if (lead.stageId && lead.stageId !== found.stage.id && stages.some((st) => st.id === lead.stageId))
      shift(lead, found.stage.id, lead.stageId);
    else setColumns((c) => ({ ...c, [found.stage.id]: replaceIn(c[found.stage.id], lead) }));
  };
  const onGone = (id: string) => {
    const found = findLead(id);
    if (found) {
      setColumns((c) => ({ ...c, [found.stage.id]: without(c[found.stage.id], id) }));
      setCounts((n) => ({ ...n, [found.stage.id]: Math.max(0, (n[found.stage.id] ?? 1) - 1) }));
    }
    setOpenId(null);
  };
  const neighbours = stages.flatMap((st) => (columns[st.id]?.items ?? []).map((x) => x.id));

  const over = keys.picked ? stages[keys.picked.to]?.id : (drag?.over ?? null);
  const tableHref = `/leads${(() => {
    const p = filtersToParams({ ...filters, stageIds: [] });
    return p.toString() ? `?${p}` : "";
  })()}`;

  return (
    <section className={s.screen}>
      <div className={l.toolbar}>
        {catalog.pipelines.length > 1 && (
          <label className={l.select}>
            <span className={l.srOnly}>Pipeline</span>
            <select
              aria-label="Pipeline"
              value={pipeline.id}
              onChange={(e) => router.push(`/pipeline?pipeline=${encodeURIComponent(e.target.value)}`)}
            >
              {catalog.pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <FilterBar
          session={session}
          catalog={catalog}
          filters={filters}
          onChange={setFilters}
          contactsVisible={contactsVisible}
          hideStage
        />
        <div className={l.right}>
          <nav className={l.views} aria-label="View">
            <Link href={tableHref}>Table</Link>
            <span aria-current="page">Board</span>
          </nav>
          {mayCreate && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New lead
            </Button>
          )}
        </div>
      </div>

      {failed && (
        <ErrorState
          title="LUME can’t load the board right now"
          message="Check your connection, then try again."
          action={{ label: "Try again", onClick: () => setReloadTick((n) => n + 1) }}
        />
      )}

      <p id="board-help" className={s.srOnly}>
        Press Space to pick up a lead, the left and right arrows to choose a stage, Enter to drop it there,
        and Escape to put it back. The arrow keys also move between leads.
      </p>
      <p role="status" className={s.srOnly}>
        {message}
      </p>

      <LayoutGroup>
        <div className={s.board} ref={board} data-dragging={drag ? "" : undefined}>
          {stages.map((stage) => {
            const page = columns[stage.id] ?? EMPTY;
            return (
              <BoardColumn
                key={stage.id}
                stage={stage}
                page={page}
                count={counts[stage.id] ?? page.items.length}
                currency={catalog.currency}
                over={
                  over === stage.id &&
                  (keys.picked ? keys.picked.to !== keys.picked.from : drag?.from.id !== stage.id)
                }
                loadingMore={loadingMore === stage.id}
                onMore={() => void loadMore(stage)}
              >
                {page.items.map((lead) => (
                  <BoardCard
                    key={lead.id}
                    lead={lead}
                    stage={stage}
                    catalog={catalog}
                    picked={keys.picked?.leadId === lead.id}
                    ghost={drag?.lead.id === lead.id}
                    onOpen={() => {
                      if (swallowClick.current || keysRef.current.picked) return;
                      setOpenId(lead.id);
                    }}
                    onKeyDown={onCardKey(lead, stage)}
                    onPointerDown={onCardPointerDown(lead, stage)}
                  />
                ))}
              </BoardColumn>
            );
          })}
        </div>
        {drag && (
          <motion.div
            className={s.lift}
            layoutId={drag.lead.id}
            style={{ left: liftX, top: liftY, width: drag.width }}
            initial={{ scale: 1 }}
            animate={{ scale: reduce ? 1 : 1.03 }}
            transition={reduce ? { duration: 0 } : toMotion(SPRINGS.default)}
            aria-hidden
          >
            <CardFace lead={drag.lead} catalog={catalog} />
          </motion.div>
        )}
      </LayoutGroup>

      {ui}
      <AnimatePresence>
        {openId && (
          <LeadDrawer
            key="drawer"
            id={openId}
            session={session}
            neighbours={neighbours}
            onClose={() => setOpenId(null)}
            onStep={setOpenId}
            onChanged={onChanged}
            onGone={onGone}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {creating && (
          <NewLeadSheet
            key="new"
            session={session}
            onClose={() => setCreating(false)}
            onCreated={(lead) => {
              setCreating(false);
              if (lead.pipelineId === pipeline.id && lead.stageId) {
                const stageId = lead.stageId;
                setColumns((c) => ({ ...c, [stageId]: insertAt(c[stageId], lead) }));
                setCounts((n) => ({ ...n, [stageId]: (n[stageId] ?? 0) + 1 }));
              }
              setOpenId(lead.id);
              toast({ tone: "ok", title: "Lead added", detail: lead.name });
            }}
          />
        )}
      </AnimatePresence>
    </section>
  );
}
