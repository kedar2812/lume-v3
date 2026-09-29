"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import type { TemplateCategory } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { TokenLine } from "@/components/templates/TokenLine";
import { Popover } from "@/components/ui/Popover";
import { SPRINGS, toMotion } from "@/lib/motion";
import { queueChanged, queuesClient, type QueuePlan, type QueueSource } from "@/lib/queues/client";
import { templatesClient, type TemplateView } from "@/lib/templates/client";
import { ordered } from "@/lib/templates/order";
import s from "./queue.module.css";

const OWN = "own";
const firstLine = (body: string) => body.split("\n").find((l) => l.trim()) ?? "";
const leads = (n: number) => `${n} ${n === 1 ? "lead" : "leads"}`;

/**
 * Message these (4C): a run's start, anchored to its trigger (a view's header, the bulk bar). Who'd be in,
 * who's left out and why (one tap away), the template (the leads' kind first), today's count against the
 * cap, and Start, the one primary action. Start opens the run.
 */
export function StartRun({
  source,
  suggest,
  label = "Message these",
  triggerClassName,
  side,
}: {
  source: QueueSource;
  /** The kind of message these leads want (a lost-leads view suggests Re-engagement). */
  suggest?: TemplateCategory;
  label?: string;
  triggerClassName?: string;
  side?: "below" | "above" | "auto";
}) {
  return (
    <Popover
      label="Start a send queue"
      size="form"
      align="end"
      side={side ?? "auto"}
      trigger={label}
      triggerClassName={triggerClassName ?? s.trigger}
    >
      {() => <StartBody source={source} suggest={suggest} />}
    </Popover>
  );
}

function StartBody({ source, suggest }: { source: QueueSource; suggest?: TemplateCategory }) {
  const router = useRouter();
  const reduce = useReducedMotion();
  const id = useId();
  const [plan, setPlan] = useState<QueuePlan | null>(null);
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [showLeftOut, setShowLeftOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(source);

  useEffect(() => {
    let live = true;
    void Promise.all([queuesClient.plan(JSON.parse(key) as QueueSource), templatesClient.list()]).then(
      ([p, l]) => {
        if (!live) return;
        if (!p.ok) return setError(p.message);
        setPlan(p.data);
        const list = l.ok ? ordered(l.data.templates, suggest) : [];
        setTemplates(list);
        setChosen(list[0]?.id ?? OWN);
      },
    );
    return () => {
      live = false;
    };
  }, [key, suggest]);

  const start = async () => {
    setBusy(true);
    setError(null);
    const r = await queuesClient.start(source, chosen === OWN ? undefined : (chosen ?? undefined));
    setBusy(false);
    if (!r.ok) return setError(r.message);
    queueChanged();
    router.push(`/queue/${r.data.queue.id}`);
  };

  if (!plan || !templates)
    return (
      <div className={s.start} aria-busy>
        {error ? (
          <p role="alert" className={s.error}>
            {error}
          </p>
        ) : (
          <>
            <span className={s.skeletonWide} />
            <span className={s.skeleton} />
            <span className={s.skeleton} />
          </>
        )}
      </div>
    );

  const left = plan.leftOut.length;
  const room = Math.max(0, plan.today.cap - plan.today.sent);
  return (
    <form
      className={s.start}
      onSubmit={(e) => {
        e.preventDefault();
        if (!plan.open && plan.total) void start();
      }}
    >
      <div className={s.who}>
        <p className={s.count}>
          {plan.total ? leads(plan.total) : "None of these can get a WhatsApp message"}
        </p>
        {left > 0 && (
          <button
            type="button"
            className={s.leftOutBtn}
            aria-expanded={showLeftOut}
            aria-controls={`${id}-left`}
            onClick={() => setShowLeftOut((v) => !v)}
          >
            {left} left out
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {showLeftOut && (
          <motion.ul
            id={`${id}-left`}
            aria-label="Left out"
            className={s.leftOut}
            initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, height: "auto" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={toMotion(SPRINGS.default)}
          >
            {plan.leftOut.map((l, i) => (
              <li key={i}>
                <span className={s.leftName}>{l.name}</span>
                <span className={s.leftWhy}>{l.reason}</span>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
      {plan.more > 0 && <p className={s.more}>{plan.more} more wait for the next run</p>}

      <div role="radiogroup" aria-label="Message" className={s.templates}>
        {[
          ...templates.map((t) => ({ id: t.id, name: t.name, line: firstLine(t.body) })),
          { id: OWN, name: "Your own words", line: "Write each one as you go" },
        ].map((o) => (
          <label key={o.id} className={s.template} data-own={o.id === OWN || undefined}>
            <input
              type="radio"
              name={`${id}-template`}
              value={o.id}
              data-name={o.name}
              checked={chosen === o.id}
              onChange={() => setChosen(o.id)}
            />
            <span className={s.tplText}>
              <span className={s.tplName}>{o.name}</span>
              <span className={s.tplLine}>
                {o.id === OWN ? o.line : <TokenLine text={o.line} fields={[]} />}
              </span>
            </span>
          </label>
        ))}
      </div>

      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {plan.open ? (
        <div className={s.openRun}>
          <p className={s.openNote}>Finish or end your current run first</p>
          <Link href={`/queue/${plan.open.id}`} className={s.resumeBtn}>
            Resume · {plan.open.done} of {plan.open.total}
          </Link>
        </div>
      ) : (
        <div className={s.foot}>
          <p className={s.today}>
            Today{" "}
            <span className={s.num}>
              {plan.today.sent} / {plan.today.cap}
            </span>
            {plan.total > room && (
              <span className={s.todayNote}>
                {room ? ` · ${room} more today, the rest tomorrow` : " · the run waits until tomorrow"}
              </span>
            )}
          </p>
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!plan.total}>
            Start
          </Button>
        </div>
      )}
    </form>
  );
}
