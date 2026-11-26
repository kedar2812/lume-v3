"use client";
import { useMemo, useState, type CSSProperties } from "react";
import { trend, type Trend } from "@lume/core/shared";
import type { IgStart, IgTotals, InstagramBoard as Data } from "@/lib/analytics/client";
import { band, niceTicks, toPts } from "@/lib/analytics/chart";
import { count, minutes, money, pct } from "@/lib/analytics/words";
import { Card, Chip, Skeleton } from "./parts";
import s from "./analytics.module.css";
import ig from "./instagram.module.css";

const STARTS: { id: IgStart; label: string; color: string }[] = [
  { id: "comment", label: "Comment", color: "var(--accent)" },
  { id: "dm", label: "First DM", color: "var(--sky)" },
  { id: "ad", label: "Ad click", color: "var(--warn)" },
  { id: "story", label: "Story reply", color: "var(--ok)" },
];
const W = 640;
const H = 216;
const TOO_FEW = 10;

/** How long an answer took, in words: seconds under a minute, then as analytics says minutes. */
export function answerTime(sec: number | null): { v: string; unit?: string } {
  if (sec === null) return { v: "—" };
  if (Math.round(sec) < 60) return { v: String(Math.round(sec)), unit: "sec" };
  if (Math.round(sec / 60) < 60) return { v: String(Math.round(sec / 60)), unit: "min" };
  const w = minutes(sec / 60);
  const m = /^(\d+) (.+)$/.exec(w);
  return m ? { v: m[1]!, unit: m[2]! } : { v: w };
}

type TileDef = {
  key: string;
  label: string;
  v: { v: string; unit?: string };
  trend: Trend | null;
  note: string;
  hero?: boolean;
  alarm?: boolean;
  tooFew?: boolean;
};

/**
 * Instagram (board Analytics, plan 2026-11-25-instagram-screens D6b): how many conversations started and what started
 * them, how fast and how often they were answered inside Instagram's window, who answered, and what they led to.
 * LUME AI's row waits for LUME AI answering on Instagram.
 */
export function InstagramBoard({
  data,
  currency,
  compare,
  rangeWords,
}: {
  data: Data | null;
  currency: string;
  compare: boolean;
  rangeWords: string;
}) {
  if (!data)
    return (
      <div aria-busy="true">
        <Skeleton h={44} />
        <div className={s.tiles} style={{ marginTop: 14 }}>
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} h={106} i={i} />
          ))}
        </div>
        <div className={s.row2}>
          <Skeleton h={300} />
          <Skeleton h={300} i={2} />
        </div>
      </div>
    );
  const c = data.totals;
  const p = compare ? data.previous : null;
  const t = (k: keyof IgTotals, good: "up" | "down" = "up") => {
    if (!p) return null;
    const a = c[k];
    const b = p[k];
    return typeof a === "number" && typeof b === "number" ? trend(a, b, { good }) : null;
  };
  const inTime = data.rates.inTime;
  const prevInTime = p && p.measured > 0 ? p.inTime / p.measured : null;
  const tiles: TileDef[] = [
    {
      key: "conversations",
      label: "Conversations",
      v: { v: count(c.conversations) },
      trend: t("conversations"),
      note: "DMs, comments, story replies, ad clicks",
    },
    {
      key: "leads",
      label: "New leads from Instagram",
      v: { v: count(c.leads) },
      trend: t("leads"),
      note:
        data.rates.leadRate === null
          ? "Made from these conversations"
          : `Made from ${pct(data.rates.leadRate)} of conversations`,
    },
    {
      key: "inTime",
      label: "Answered in time",
      v: { v: inTime === null ? "—" : pct(inTime) },
      trend: inTime !== null && prevInTime !== null ? trend(inTime, prevInTime, { kind: "pts" }) : null,
      note: "Inside Instagram’s 24 hours (7 days after an ad)",
      tooFew: c.measured > 0 && c.measured < TOO_FEW,
    },
    {
      key: "first",
      label: "First answer (median)",
      v: answerTime(c.firstAnswerSec),
      trend:
        p && c.firstAnswerSec !== null && p.firstAnswerSec !== null
          ? trend(c.firstAnswerSec, p.firstAnswerSec, {
              kind: "abs",
              good: "down",
              format: (n) => {
                const w = answerTime(n);
                return w.unit ? `${w.v} ${w.unit}` : w.v;
              },
            })
          : null,
      note: "Flows and your team",
    },
    {
      key: "booked",
      label: "Calls booked",
      v: { v: count(c.booked) },
      trend: t("booked"),
      note: "After the conversation started",
    },
    ...(c.revenue !== null
      ? [
          {
            key: "revenue",
            label: "Revenue won",
            v: { v: money(c.revenue, currency) },
            trend: t("revenue"),
            note: `From ${count(c.won)} ${c.won === 1 ? "lead" : "leads"} won after a conversation`,
            hero: true,
          },
        ]
      : []),
    {
      key: "won",
      label: "Won",
      v: { v: count(c.won) },
      trend: t("won"),
      note: "After the conversation started",
    },
    {
      key: "privateReplies",
      label: "Private replies sent",
      v: { v: count(c.privateReplies) },
      trend: t("privateReplies"),
      note: "One per comment, within 7 days",
    },
    {
      key: "adClicks",
      label: "Ad clicks that wrote in",
      v: { v: count(c.adClicks) },
      trend: t("adClicks"),
      note: "Open for 7 days, not 24 hours",
    },
    {
      key: "ranOut",
      label: "Time to answer ran out",
      v: { v: count(c.ranOut) },
      trend: t("ranOut", "down"),
      note: "Nobody answered inside Instagram’s window",
    },
    {
      key: "stopped",
      label: "Asked to stop",
      v: { v: count(c.stopped) },
      trend: t("stopped", "down"),
      note: "LUME won’t message them again",
      alarm: !!p && c.stopped > p.stopped,
    },
  ];
  return (
    <>
      <div className={s.head}>
        <div>
          <h2>
            {c.conversations
              ? `Instagram started ${count(c.conversations)} ${c.conversations === 1 ? "conversation" : "conversations"} ${rangeWords}.`
              : `No conversations on Instagram ${rangeWords}.`}
          </h2>
          {c.conversations > 0 && (
            <p>
              {count(c.leads)} new {c.leads === 1 ? "lead" : "leads"} came from them, and {count(c.booked)}{" "}
              booked a call.
            </p>
          )}
        </div>
      </div>

      <div className={s.tiles}>
        {tiles.map((x, i) => (
          <div
            key={x.key}
            className={`${s.tile} ${x.hero ? s.hero : ""} ${x.alarm ? s.alarm : ""}`}
            style={{ "--i": i } as CSSProperties}
            data-alarm={x.alarm || undefined}
            role="group"
            aria-label={`${x.label}: ${x.v.v}${x.v.unit ? ` ${x.v.unit}` : ""}${x.trend ? `, ${x.trend.text}` : ""}`}
          >
            <div className={s.tileLabel}>{x.label}</div>
            <div className={s.tileValue}>
              {x.v.v}
              {x.v.unit && <small>{x.v.unit}</small>}
            </div>
            {x.tooFew ? <span className={s.thin}>Too few to say yet</span> : <Chip trend={x.trend} />}
            <span className={s.tileNote}>{x.note}</span>
          </div>
        ))}
      </div>

      <div className={s.row2}>
        <Card title="Conversations started, by what started them" sub="Per day" i={12}>
          <StartsChart data={data} />
        </Card>
        <Card title="Where people stop" sub={`Of the conversations that started ${rangeWords}`} i={13}>
          <Steps data={data} />
        </Card>
      </div>

      <div className={s.row3}>
        <Card
          title="Who answered"
          sub={`Flows and your team, ${rangeWords}. A conversation counts for each one that answered it.`}
          i={14}
        >
          <Who data={data} currency={currency} />
        </Card>
        <Card title="Each account" sub="Where the conversations arrived" i={15}>
          <Accounts data={data} />
        </Card>
        <Card title="The posts and ads that started them" sub="By the leads they brought" i={16}>
          <Sources data={data} />
        </Card>
      </div>
    </>
  );
}

function StartsChart({ data }: { data: Data }) {
  const [hidden, setHidden] = useState<Partial<Record<IgStart, boolean>>>({});
  const [hi, setHi] = useState<number | null>(null);
  const days = data.series;
  const n = days.length;
  const shownStarts = STARTS.filter((x) => !hidden[x.id]);
  const totals = days.map((d) => shownStarts.reduce((a, x) => a + d[x.id], 0));
  const ticks = niceTicks(Math.max(1, ...totals));
  const max = ticks.at(-1)!;
  const bands = useMemo(() => {
    let base = Array(n).fill(0) as number[];
    return STARTS.map((x) => {
      const on = !hidden[x.id];
      const top = base.map((b, i) => b + (on ? days[i]![x.id] : 0));
      const d = band(toPts(top, W, H, max, 6), toPts(base, W, H, max, 6));
      base = top;
      return { key: x.id, d, color: x.color, on };
    });
  }, [days, hidden, max, n]);
  if (!n || days.every((d) => STARTS.every((x) => d[x.id] === 0)))
    return <p className={s.empty}>No conversations started in this range yet.</p>;
  const step = n > 1 ? (W - 12) / (n - 1) : 0;
  const words = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  const labels =
    n > 1 ? [0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1] : [0];
  return (
    <>
      <div className={s.legend} style={{ marginBottom: 8 }}>
        {STARTS.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-pressed={!hidden[x.id]}
            onClick={() => setHidden((h) => ({ ...h, [x.id]: !h[x.id] }))}
          >
            <i style={{ background: x.color }} />
            {x.label}
          </button>
        ))}
      </div>
      <div className={s.chart} style={{ height: 236 }}>
        <svg
          viewBox={`0 0 ${W} 236`}
          preserveAspectRatio="none"
          style={{ height: 236 }}
          role="img"
          aria-label="Conversations started per day, by what started them"
        >
          {ticks.slice(1).map((v) => {
            const y = 6 + (1 - v / max) * (H - 12);
            return (
              <g key={v}>
                <line className={s.gridLine} x1="0" x2={W} y1={y} y2={y} />
                <text className={s.axis} x="0" y={y - 4}>
                  {count(v)}
                </text>
              </g>
            );
          })}
          {[...bands].reverse().map((b) => (
            <path
              key={b.key}
              className={s.band}
              d={b.d}
              fill={b.color}
              fillOpacity={0.5}
              style={{ opacity: b.on ? 1 : 0 }}
            />
          ))}
          {hi !== null && <line className={s.hov} x1={6 + hi * step} x2={6 + hi * step} y1="8" y2="216" />}
          {labels.map((i) => (
            <text key={i} className={s.axis} x={6 + i * step} y="234" textAnchor="middle">
              {words(days[i]!.day).replace(/^(\w{3})\w*/, "$1")}
            </text>
          ))}
        </svg>
        <div
          style={{ position: "absolute", inset: 0 }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHi(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
          }}
          onPointerLeave={() => setHi(null)}
        />
        {hi !== null && (
          <div
            className={s.tip}
            style={{
              left: `clamp(0px, calc(${(hi / Math.max(1, n - 1)) * 100}% - 84px), calc(100% - 180px))`,
            }}
          >
            <b>{words(days[hi]!.day)}</b>
            {shownStarts.map((x) => (
              <div key={x.id} className={s.tipRow}>
                <span>
                  <i style={{ background: x.color }} />
                  {x.label}
                </span>
                <em>{count(days[hi]![x.id])}</em>
              </div>
            ))}
            <div
              className={s.tipRow}
              style={{ borderTop: "0.5px solid var(--line)", marginTop: 6, paddingTop: 6 }}
            >
              <span>All of them</span>
              <em>{count(totals[hi] ?? 0)}</em>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const STEP_NAMES: Record<Data["funnel"][number]["id"], string> = {
  wrote: "Started a conversation",
  lead: "Became a lead",
  booked: "Booked a call",
  won: "Won",
};

function Steps({ data }: { data: Data }) {
  const first = data.funnel[0]?.n ?? 0;
  if (!first)
    return <p className={s.empty}>No conversations started in this range, so there’s nothing to follow.</p>;
  return (
    <div className={s.funnel}>
      {data.funnel.map((st, i) => {
        const share = st.n / first;
        return (
          <div key={st.id} className={s.stage}>
            <span className={s.stageName}>{STEP_NAMES[st.id]}</span>
            <span className={s.track}>
              <span
                className={s.fill}
                data-won={st.id === "won" || undefined}
                style={{ width: `${Math.max(4, share * 100)}%`, "--i": i } as CSSProperties}
              >
                <b>{count(st.n)}</b>
              </span>
            </span>
            <span className={s.share}>{pct(share, share > 0 && share < 0.1 ? 1 : 0)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Who({ data, currency }: { data: Data; currency: string }) {
  const rows = data.whoAnswered;
  if (rows.every((r) => !r.conversations))
    return <p className={s.empty}>Nobody has answered a conversation in this range yet.</p>;
  return (
    <ul className={ig.rows}>
      {rows.map((r) => {
        const time = answerTime(r.firstAnswerSec);
        return (
          <li key={r.id}>
            <span className={ig.name}>{r.id === "flows" ? "Flows" : "Your team"}</span>
            <span className={ig.nums}>
              <span>
                <b>{count(r.conversations)}</b> {r.conversations === 1 ? "conversation" : "conversations"}
              </span>
              <span>
                <b>{count(r.booked)}</b> booked
              </span>
              <span>
                <b>{count(r.won)}</b> won
                {r.revenue !== null && r.won > 0 ? ` · ${money(r.revenue, currency)}` : ""}
              </span>
              <span>
                <b>
                  {time.v}
                  {time.unit ? ` ${time.unit}` : ""}
                </b>{" "}
                first answer
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const STATUS_WORDS: Record<string, string> = {
  needs_attention: "Needs connecting again: messages wait meanwhile",
  disconnected: "Disconnected",
};

function Accounts({ data }: { data: Data }) {
  if (!data.accounts.length) return <p className={s.empty}>No Instagram account is connected.</p>;
  return (
    <ul className={ig.rows}>
      {data.accounts.map((a) => (
        <li key={a.id} data-warn={a.status !== "active" || undefined}>
          <span className={ig.name}>
            {a.username ? `@${a.username}` : "An Instagram account"}
            {STATUS_WORDS[a.status] && <small>{STATUS_WORDS[a.status]}</small>}
          </span>
          <span className={ig.nums}>
            <span>
              <b>{count(a.conversations)}</b> {a.conversations === 1 ? "conversation" : "conversations"}
            </span>
            <span>
              <b>{count(a.leads)}</b> {a.leads === 1 ? "lead" : "leads"}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const KIND_WORDS: Record<string, string> = {
  ad: "Ad",
  reels: "Reel",
  reel: "Reel",
  video: "Video",
  image: "Post",
  carousel_album: "Post",
  post: "Post",
};

function Sources({ data }: { data: Data }) {
  if (!data.sources.length)
    return <p className={s.empty}>No post or ad started a conversation in this range yet.</p>;
  return (
    <ul className={ig.rows}>
      {data.sources.map((x) => (
        <li key={`${x.kind}:${x.id}`}>
          <span className={ig.name}>
            {KIND_WORDS[x.kind] ?? "Post"}
            <small title={x.id}>{x.id}</small>
          </span>
          <span className={ig.nums}>
            <span>
              <b>{count(x.conversations)}</b> wrote in
            </span>
            <span>
              <b>{count(x.leads)}</b> {x.leads === 1 ? "lead" : "leads"}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
