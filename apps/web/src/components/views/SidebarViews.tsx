"use client";
import { AnimatePresence, Reorder, motion, useDragControls, useReducedMotion } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { usePageNav } from "@/components/shell/PageTransition";
import { Popover } from "@/components/ui/Popover";
import { tokenColor } from "@/lib/leads/colors";
import { SPRINGS, toMotion } from "@/lib/motion";
import { useLeadsChanged, useStream } from "@/lib/notifications/stream";
import { VIEWS_CHANGED, viewsChanged, viewsClient, type RoleName, type ViewView } from "@/lib/views/client";
import { ViewForm, type ViewFormValue } from "./ViewForm";
import s from "./views.module.css";

const href = (v: ViewView) => `/leads?view=${v.id}`;

/**
 * The Views section of the sidebar (4B; spec §6): each saved view with its colour, name and live count,
 * under the main navigation. Counts refresh when leads change (never by polling); drag or Alt+↑/↓ sets
 * the person's own order.
 */
export function SidebarViews({ canShare = false }: { canShare?: boolean }) {
  const reduce = useReducedMotion();
  const { toast } = useToast();
  const { go } = usePageNav();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const active = pathname === "/leads" ? params.get("view") : null;
  const [views, setViews] = useState<ViewView[] | null>(null);
  const [roles, setRoles] = useState<RoleName[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const listed = useRef<string[]>([]);

  // Each ask is numbered: an answer to an older one that arrives late is let go (never shown over a newer).
  const asked = useRef({ views: 0, counts: 0 });
  const loadViews = useCallback(async () => {
    const n = ++asked.current.views;
    const r = await viewsClient.list();
    if (!r.ok || n !== asked.current.views) return;
    listed.current = r.data.views.map((v) => v.id);
    setViews(r.data.views);
    setRoles(r.data.roles ?? null);
  }, []);
  const loadCounts = useCallback(async () => {
    const n = ++asked.current.counts;
    const r = await viewsClient.counts();
    if (!r.ok || n !== asked.current.counts) return;
    setCounts(r.data.counts);
    // Counts cover exactly the views this person may see now: a difference means someone shared or
    // un-shared a view elsewhere, so the list looks again (4B review, Important 3).
    const seen = Object.keys(r.data.counts).sort().join();
    if (seen !== [...listed.current].sort().join()) void loadViews();
  }, [loadViews]);
  useEffect(() => {
    void loadViews();
    void loadCounts();
    const again = () => {
      void loadViews();
      void loadCounts();
    };
    window.addEventListener(VIEWS_CHANGED, again);
    return () => {
      window.removeEventListener(VIEWS_CHANGED, again);
      clearTimeout(timer.current);
    };
  }, [loadViews, loadCounts]);
  // A burst of changes (an import) asks once.
  const soon = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void loadCounts(), 250);
  };
  useLeadsChanged(soon);
  // Time moves counts too (a follow-up falls due; a day turns): a reminder arriving, or coming back to
  // the tab, asks again. Never a timer (spec §3 View counts).
  useStream(soon);
  useEffect(() => {
    const back = () => document.visibilityState !== "hidden" && soon();
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  });

  const saveOrder = (next: ViewView[]) => void viewsClient.order(next.map((v) => v.id));
  const move = (v: ViewView, step: -1 | 1) => {
    if (!views) return;
    const at = views.findIndex((x) => x.id === v.id);
    const to = at + step;
    if (to < 0 || to >= views.length) return;
    const next = [...views];
    next.splice(at, 1);
    next.splice(to, 0, v);
    setViews(next);
    saveOrder(next);
  };
  const edit = async (v: ViewView, value: ViewFormValue): Promise<string | null> => {
    const patch = {
      ...(value.name !== v.name ? { name: value.name } : {}),
      ...(value.color !== v.color ? { color: value.color } : {}),
      ...(value.sharedRoleIds.join() !== v.sharedRoleIds.join()
        ? { sharedRoleIds: value.sharedRoleIds }
        : {}),
    };
    if (!Object.keys(patch).length) return null;
    const r = await viewsClient.update(v.id, patch);
    if (!r.ok) return r.message;
    setViews((all) => all && all.map((x) => (x.id === v.id ? r.data : x)));
    viewsChanged();
    return null;
  };
  const remove = async (v: ViewView) => {
    setViews((all) => all && all.filter((x) => x.id !== v.id));
    const r = await viewsClient.remove(v.id);
    if (!r.ok) {
      void loadViews();
      return toast({ tone: "danger", title: "That view wasn’t deleted", detail: r.message });
    }
    toast({
      title: `Deleted “${v.name}”`,
      action: {
        label: "Undo",
        onClick: () =>
          void viewsClient.restore(v.id).then((back) => {
            if (back.ok) return viewsChanged();
            toast({ tone: "danger", title: `“${v.name}” couldn’t come back`, detail: back.message });
          }),
      },
    });
  };

  if (!views?.length) return null;
  return (
    <section className={s.section} aria-labelledby="views-head">
      <p id="views-head" className={s.head}>
        Views
      </p>
      <Reorder.Group
        as="ul"
        axis="y"
        values={views}
        onReorder={setViews}
        className={s.list}
        aria-label="Views"
      >
        <AnimatePresence initial={false}>
          {views.map((v) => (
            <Row
              key={v.id}
              view={v}
              namesake={!v.mine && views.some((x) => x.mine && x.name.toLowerCase() === v.name.toLowerCase())}
              count={counts[v.id]}
              on={active === v.id}
              reduce={!!reduce}
              canShare={canShare}
              roles={roles}
              // Already on Leads, a view opens in place; from elsewhere, with the page transition.
              onGo={() => (pathname === "/leads" ? router.push(href(v)) : go(href(v)))}
              onMove={(step) => move(v, step)}
              onDropped={() => saveOrder(views)}
              onEdit={(value) => edit(v, value)}
              onDelete={() => void remove(v)}
            />
          ))}
        </AnimatePresence>
      </Reorder.Group>
    </section>
  );
}

function Row({
  view: v,
  namesake,
  count,
  on,
  reduce,
  canShare,
  roles,
  onGo,
  onMove,
  onDropped,
  onEdit,
  onDelete,
}: {
  view: ViewView;
  /** Shared with this person under the name of one of their own. */
  namesake: boolean;
  count: number | null | undefined;
  on: boolean;
  reduce: boolean;
  canShare: boolean;
  roles: RoleName[] | null;
  onGo: () => void;
  onMove: (step: -1 | 1) => void;
  onDropped: () => void;
  onEdit: (value: ViewFormValue) => Promise<string | null>;
  onDelete: () => void;
}) {
  const drag = useDragControls();
  const onHandleKey = (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    onMove(e.key === "ArrowUp" ? -1 : 1);
  };
  return (
    <Reorder.Item
      as="li"
      value={v}
      dragListener={false}
      dragControls={drag}
      onDragEnd={onDropped}
      className={s.row}
      data-on={on || undefined}
      initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
      transition={reduce ? { duration: 0.15 } : toMotion(SPRINGS.default)}
    >
      <button
        type="button"
        className={s.handle}
        aria-label={`Move ${v.name}`}
        title="Drag, or Alt + ↑ / ↓"
        onPointerDown={(e) => drag.start(e)}
        onKeyDown={onHandleKey}
      >
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
          <path
            d="M4 3h.01M8 3h.01M4 6h.01M8 6h.01M4 9h.01M8 9h.01"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <Link
        href={href(v)}
        className={s.link}
        aria-current={on ? "page" : undefined}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onGo();
        }}
      >
        <span className={s.dot} style={{ background: tokenColor(v.color) }} aria-hidden />
        <span className={s.name}>{v.name}</span>
        {/* Named like one of yours: this one says it's shared, so two rows never look alike. */}
        {namesake && <span className={s.sharedTag}>Shared</span>}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={String(count)}
            className={s.count}
            // Counts change from run to run: the visual checks mask them (they are not times, so never resized).
            data-live-count
            {...(count === null ? { title: "LUME can't count this view any more" } : {})}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {count === null ? "—" : count === undefined ? "" : count.toLocaleString("en")}
          </motion.span>
        </AnimatePresence>
      </Link>
      {!v.canEdit && <span className={s.slot} data-slot aria-hidden />}
      {v.canEdit && (
        <Popover
          label={`Edit ${v.name}`}
          triggerLabel={`Edit ${v.name}`}
          size="form"
          triggerClassName={s.more}
          trigger={
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path
                d="M3.5 8h.01M8 8h.01M12.5 8h.01"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          }
        >
          {(close) => (
            <ViewForm
              initial={{ name: v.name, color: v.color, sharedRoleIds: v.sharedRoleIds }}
              canShare={canShare}
              // Only its owner can take a shared view back to private (4B review, Important 1).
              canMakePrivate={v.mine || !v.shared}
              roles={roles}
              onSubmit={async (value) => {
                const refused = await onEdit(value);
                if (!refused) close();
                return refused;
              }}
              onDelete={() => {
                close();
                onDelete();
              }}
            />
          )}
        </Popover>
      )}
    </Reorder.Item>
  );
}
