"use client";
import { READY_GROUPS, READY_KEYS, readyFlow, type ReadyFlow, type ReadyGroup } from "@lume/core/shared";
import { useRouter } from "next/navigation";
import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FLOW_TEMPLATE_ICONS, ICON_SIZE, TRIGGER_ICONS, UI_ICONS } from "@/components/ui/icons";
import { flowsClient } from "@/lib/flows/client";
import s from "./newflow.module.css";

const BLANK = "blank";
const { add: Plus, search: Search, warning: TriangleAlert, info: Info } = UI_ICONS;
const READY = READY_KEYS.map(readyFlow);
/** What starts each, on its card. */
const STARTS_ON: Record<ReadyFlow["trigger"]["kind"], string> = {
  comment: "Comment keyword",
  dm: "DM keyword",
  story_reply: "Story reply",
  story_mention: "Story mention",
  ad: "Ad click",
  welcome: "First message",
};
const GROUPS: { id: ReadyGroup | "all"; label: string }[] = [{ id: "all", label: "All" }, ...READY_GROUPS];
const GROUP_OF = Object.fromEntries(READY_GROUPS.map((g) => [g.id, g.label]));

/**
 * New flow (plan 2026-11-25-instagram-screens D4; canvas board NewFlow, owner 2026-11-25): the ready-made flows by what
 * they're for, searchable, each with its steps in words before anything is made; or a flow from nothing. Use makes it a
 * draft under its own name and opens it on the canvas, ready to change.
 */
export function NewFlowSheet({ onClose }: { onClose(): void }) {
  const router = useRouter();
  const [group, setGroup] = useState<ReadyGroup | "all">("all");
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string>(READY[0]!.key);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const [making, setMaking] = useState(false);
  const grid = useRef<HTMLDivElement>(null);

  const query = q.trim().toLowerCase();
  const fits = (f: ReadyFlow) => !query || `${f.name} ${f.what} ${f.starts}`.toLowerCase().includes(query);
  const inGroup = (f: ReadyFlow, g: ReadyGroup | "all") => g === "all" || f.group === g;
  const shown = READY.filter((f) => inGroup(f, group) && fits(f));
  const picked = READY.find((f) => f.key === pick) ?? null;
  const order = [BLANK, ...shown.map((f) => f.key)];

  const use = async () => {
    if (busy.current) return;
    busy.current = true;
    setMaking(true);
    setError(null);
    const r = await flowsClient.create(
      picked ? { name: picked.name, template: picked.key } : { name: "New flow" },
    );
    busy.current = false;
    setMaking(false);
    if (!r.ok) return setError(r.message);
    router.push(`/instagram/flows/${r.data.id}`);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = Math.max(0, order.indexOf(pick));
    const next = order[(i + step + order.length) % order.length]!;
    setPick(next);
    grid.current?.querySelector<HTMLElement>(`[data-key="${next}"]`)?.focus();
  };

  return (
    <Dialog label="New flow" onClose={onClose} width={1080} className={s.sheet}>
      <header className={s.head}>
        <div>
          <h2 className={s.title}>New flow</h2>
          <p className={s.lead}>
            Start from one that works, or from nothing. You can change every word and step before it goes
            live.
          </p>
        </div>
      </header>
      <div className={s.bar}>
        <label className={s.search}>
          <Search size={ICON_SIZE.md} aria-hidden />
          <span className={s.srOnly}>Search ready-made flows</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search: price, guide, giveaway…"
          />
        </label>
        <div className={s.groups} role="tablist" aria-label="What it's for">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={group === g.id}
              className={s.group}
              onClick={() => setGroup(g.id)}
            >
              {g.label}
              <span className={s.count}>{READY.filter((f) => inGroup(f, g.id) && fits(f)).length}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={s.body}>
        <div ref={grid} className={s.grid} role="listbox" aria-label="Ready-made flows" onKeyDown={onKey}>
          <button
            type="button"
            role="option"
            data-key={BLANK}
            aria-selected={pick === BLANK}
            // The picked card is the one Tab lands on; when a search hides it, this one is.
            tabIndex={pick === BLANK || !order.includes(pick) ? 0 : -1}
            className={s.card}
            onClick={() => setPick(BLANK)}
          >
            <span className={s.tile} aria-hidden>
              <Plus size={ICON_SIZE.tile} />
            </span>
            <b>Start from nothing</b>
            <span className={s.what}>An empty canvas and a trigger to choose.</span>
          </button>
          {shown.map((f) => {
            const Icon = FLOW_TEMPLATE_ICONS[f.key];
            const Starts = TRIGGER_ICONS[f.trigger.kind];
            return (
              <button
                key={f.key}
                type="button"
                role="option"
                data-key={f.key}
                aria-selected={pick === f.key}
                tabIndex={pick === f.key ? 0 : -1}
                className={s.card}
                onClick={() => setPick(f.key)}
              >
                <span className={s.tile} aria-hidden>
                  <Icon size={ICON_SIZE.tile} />
                </span>
                <b>{f.name}</b>
                <span className={s.what}>{f.what}</span>
                <span className={s.trig}>
                  <Starts size={ICON_SIZE.sm} aria-hidden />
                  {STARTS_ON[f.trigger.kind]}
                </span>
              </button>
            );
          })}
          {shown.length === 0 && (
            <p className={s.none}>
              No ready-made flow fits “{q.trim()}”. Start from nothing, or try another word.
            </p>
          )}
        </div>
        <aside
          className={s.preview}
          aria-label={picked ? `${picked.name}, step by step` : "Start from nothing"}
        >
          {picked ? (
            <>
              <div className={s.ph}>
                <span className={s.tile} aria-hidden>
                  {(() => {
                    const Icon = FLOW_TEMPLATE_ICONS[picked.key];
                    return <Icon size={ICON_SIZE.tile} />;
                  })()}
                </span>
                <div>
                  <b>{picked.name}</b>
                  <span>
                    {GROUP_OF[picked.group]} · {STARTS_ON[picked.trigger.kind]}
                  </span>
                </div>
              </div>
              <p className={s.why}>{picked.why}</p>
              <div className={s.starts}>
                <span className={s.cap}>Starts when</span>
                <span>{picked.starts}</span>
              </div>
              <ol className={s.steps}>
                {picked.preview.map(([kind, text], i) => (
                  <li key={`${kind}-${i}`} data-hand={kind.startsWith("Hand to") || undefined}>
                    <span className={s.n}>{i + 1}</span>
                    <div>
                      <b>{kind}</b>
                      <span>{text}</span>
                    </div>
                  </li>
                ))}
              </ol>
              <p className={s.fill}>
                {picked.fill.startsWith("Ready as it is") ? (
                  <Info size={ICON_SIZE.sm} aria-hidden />
                ) : (
                  <TriangleAlert size={ICON_SIZE.sm} aria-hidden />
                )}
                {picked.fill}
              </p>
            </>
          ) : (
            <>
              <div className={s.ph}>
                <span className={s.tile} aria-hidden>
                  <Plus size={ICON_SIZE.tile} />
                </span>
                <div>
                  <b>Start from nothing</b>
                  <span>Your own flow</span>
                </div>
              </div>
              <p className={s.why}>Choose what starts it, then add steps.</p>
            </>
          )}
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          <div className={s.go}>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={making} onClick={() => void use()}>
              {picked ? "Use this flow" : "Start"}
            </Button>
          </div>
        </aside>
      </div>
    </Dialog>
  );
}
