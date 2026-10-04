"use client";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { METRICS } from "@lume/core/shared";
import { Chip, Spark } from "@/components/analytics/parts";
import { analyticsClient, type Funnel, type Glance } from "@/lib/analytics/client";
import { shown } from "@/lib/analytics/words";
import s from "./glance.module.css";

/** What each quick stat is called on Today, and what its trend is measured against. */
const LABEL: Record<string, string> = {
  new_leads: "New leads",
  reply_rate: "Reply rate",
  calls_booked: "Calls booked",
  revenue_won: "Revenue won",
};

/**
 * Today's quick stats (frontend spec §8.2, today-prototype.html): four numbers with their trend and the period's own
 * line, each opening Analytics. New leads, reply rate and calls booked are this week against last; revenue this month
 * against last (only with the money permission). Quiet skeletons while they load; nothing at all if they can't.
 */
export function TodayKpis({ currency }: { currency: string }) {
  const [g, setG] = useState<Glance | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void analyticsClient.glance().then((r) => {
      if (!live) return;
      if (r.ok) setG(r.data);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, []);
  if (failed) return null;
  return (
    <section className={s.kpis} aria-label="How it's going" aria-busy={!g || undefined}>
      {(g?.kpis ?? Array.from({ length: 4 }, () => null)).map((k, i) =>
        k ? (
          <Link
            key={k.id}
            href={`/analytics?range=${k.period === "month" ? "this_month" : "7d"}`}
            className={s.kpi}
            aria-label={`${LABEL[k.id] ?? METRICS[k.id].words}: ${fmt(k, currency)}${k.trend ? `, ${k.trend.text}` : ""}`}
          >
            <span className={s.k}>{LABEL[k.id] ?? METRICS[k.id].words}</span>
            <span className={s.v}>{fmt(k, currency)}</span>
            <span className={s.d}>
              {k.trend ? <Chip trend={k.trend} /> : <span className={s.flat}>No change to show</span>}
              <span className={s.vs}>{k.period === "month" ? "vs last month" : "vs last week"}</span>
            </span>
            <span className={s.spark}>
              <Spark values={k.series} />
            </span>
          </Link>
        ) : (
          <div key={i} className={s.kpi} aria-hidden>
            <span className={s.skel} style={{ width: "50%" }} />
            <span className={s.skel} style={{ width: "40%", height: 24, marginTop: 10 }} />
            <span className={s.skel} style={{ width: "60%", marginTop: 10 }} />
          </div>
        ),
      )}
    </section>
  );
}
const fmt = (k: Glance["kpis"][number], currency: string) => {
  const v = shown(k, currency);
  return `${v.v}${v.unit ? ` ${v.unit}` : ""}`;
};

/**
 * The pipeline at a glance (Today's right column): how far this month's leads have got, stage by stage, each bar a
 * share of those that arrived. Opens the Funnel.
 */
export function TodayPipeline() {
  const reduce = !!useReducedMotion();
  const [f, setF] = useState<Funnel | null>(null);
  useEffect(() => {
    let live = true;
    void analyticsClient
      .funnel({ range: "this_month", compare: false })
      .then((r) => live && r.ok && setF(r.data));
    return () => {
      live = false;
    };
  }, []);
  if (!f || !f.arrived) return null;
  const stages = f.stages.slice(0, 6);
  return (
    <section className={s.card} aria-labelledby="today-pipeline">
      <div className={s.cardHead}>
        <h2 id="today-pipeline">Pipeline</h2>
        <span>This month</span>
        <Link href="/analytics?m=funnel&range=this_month" className={s.more}>
          Funnel ›
        </Link>
      </div>
      <ul className={s.fn}>
        {stages.map((st, i) => (
          <li key={st.id}>
            <span className={s.fl}>{st.name}</span>
            <span className={s.fb} aria-hidden>
              <motion.i
                initial={reduce ? false : { scaleX: 0 }}
                animate={{ scaleX: f.arrived ? st.reached / f.arrived : 0 }}
                transition={{ type: "spring", bounce: 0, duration: 0.9, delay: reduce ? 0 : i * 0.06 }}
              />
            </span>
            <b className={s.fnum}>{st.reached.toLocaleString("en-US")}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}
