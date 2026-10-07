"use client";
import { plural } from "@lume/core/shared";
import { useEffect, useState, type CSSProperties } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import {
  analyticsClient,
  type AnalyticsParams,
  type Insights,
  type Lost,
  type Segments,
} from "@/lib/analytics/client";
import { count, money, pct } from "@/lib/analytics/words";
import { Card, Chip, Skeleton } from "./parts";
import a from "./analytics.module.css";
import s from "./lost.module.css";

const SLICE = ["#e5484d", "#f2a20c", "#2a5bff", "#5ab8ff", "#18a566", "#8a94a6", "#c2410c", "#0e7490"];
/** The insights that belong beside the stage they left at. */
const LOST_INSIGHTS = ["stage_drop", "lost_reason_up", "won_back"];
const LIVE_DAYS = 92;

/**
 * Lost (canvas Lost): why leads were lost (a donut, each reason opening its leads), reasons by source (a heatmap), the
 * stage they left at, those won back (lost → reopened → won, and the money recovered), and what converts: the win rate
 * by each answer to any choice field.
 */
export function LostBoard({
  lost,
  insights,
  params,
  rangeWords,
  rangeDays,
  currency,
  compare,
  onDrill,
}: {
  lost: Lost | null;
  insights: Insights | null;
  params: AnalyticsParams;
  rangeWords: string;
  rangeDays: number;
  currency: string;
  compare: boolean;
  onDrill(token: string, title: string): void;
}) {
  if (!lost)
    return (
      <div className={s.lg2}>
        <Skeleton h={420} />
        <Skeleton h={420} i={1} />
        <Skeleton h={420} i={2} />
      </div>
    );
  const insight =
    insights?.ready === true ? insights.insights.find((i) => LOST_INSIGHTS.includes(i.id)) : undefined;
  return (
    <>
      <div className={s.lg2}>
        <Reasons lost={lost} rangeWords={rangeWords} onDrill={onDrill} />
        <Matrix lost={lost} onDrill={onDrill} />
        <Stages lost={lost} insight={insight} onDrill={onDrill} />
      </div>
      <div className={s.lg3}>
        <WonBack
          lost={lost}
          rangeWords={rangeWords}
          currency={currency}
          compare={compare}
          onDrill={onDrill}
        />
        <Converts params={params} rangeDays={rangeDays} onDrill={onDrill} />
      </div>
    </>
  );
}

function Reasons({
  lost,
  rangeWords,
  onDrill,
}: {
  lost: Lost;
  rangeWords: string;
  onDrill(token: string, title: string): void;
}) {
  const [hot, setHot] = useState<number | null>(null);
  const items = lost.reasons.slice(0, 8);
  const C = 2 * Math.PI * 66;
  let at = 0;
  const slices = items.map((r, i) => {
    const len = (r.n / (lost.total || 1)) * C;
    const sl = { len, off: -at, color: SLICE[i % SLICE.length]! };
    at += len;
    return sl;
  });
  return (
    <Card
      title="Why they were lost"
      sub={`${count(lost.total)} ${lost.total === 1 ? "lead" : "leads"} lost ${rangeWords}`}
    >
      {!lost.total ? (
        <p className={a.empty}>No leads were lost {rangeWords}.</p>
      ) : (
        <>
          <div className={s.dnw}>
            <svg viewBox="0 0 176 176" aria-hidden>
              <circle cx="88" cy="88" r="66" className={s.track} />
              {slices.map((sl, i) => (
                <circle
                  key={i}
                  cx="88"
                  cy="88"
                  r="66"
                  className={s.sl}
                  data-hot={hot === i || undefined}
                  data-dim={(hot !== null && hot !== i) || undefined}
                  stroke={sl.color}
                  strokeDasharray={`${Math.max(0, sl.len - (slices.length > 1 ? 2 : 0))} ${C}`}
                  strokeDashoffset={sl.off}
                  style={{ "--i": i } as CSSProperties}
                />
              ))}
            </svg>
            <div className={s.ctr}>
              <div>
                <b>{count(hot === null ? lost.total : items[hot]!.n)}</b>
                <span>{hot === null ? "lost" : items[hot]!.name}</span>
              </div>
            </div>
          </div>
          <div className={s.rl}>
            {items.map((r, i) => (
              <button
                key={r.id ?? "none"}
                type="button"
                data-hot={hot === i || undefined}
                disabled={!r.drill}
                onPointerEnter={() => setHot(i)}
                onPointerLeave={() => setHot(null)}
                onFocus={() => setHot(i)}
                onBlur={() => setHot(null)}
                onClick={() => r.drill && onDrill(r.drill, `Lost: ${r.name}`)}
              >
                <i style={{ background: SLICE[i % SLICE.length] }} />
                <span className={s.rn}>{r.name}</span>
                <em>{count(r.n)}</em>
                <span className={s.pc}>{r.share === null ? "—" : pct(r.share)}</span>
              </button>
            ))}
            {lost.reasons.length > items.length && (
              <p className={s.more}>and {lost.reasons.length - items.length} more reasons</p>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function Matrix({ lost, onDrill }: { lost: Lost; onDrill(token: string, title: string): void }) {
  const m = lost.matrix;
  const max = Math.max(1, ...m.cells.map((c) => c.n));
  const cell = (r: string | null, src: string | null) =>
    m.cells.find((c) => c.reasonId === r && c.sourceId === src);
  return (
    <Card title="Reasons, by source" sub="Where each reason comes from: the darker, the more leads">
      {!m.reasons.length || !m.sources.length ? (
        <p className={a.empty}>Nothing lost to group yet.</p>
      ) : (
        <>
          <div
            className={s.hm}
            role="table"
            aria-label="Leads lost, by reason and source"
            style={{ gridTemplateColumns: `118px repeat(${m.sources.length}, minmax(0, 1fr))` }}
          >
            <div role="row" className={s.hrow}>
              <span role="columnheader" />
              {m.sources.map((x) => (
                <span key={x.id ?? "none"} role="columnheader" className={s.hh} title={x.name}>
                  {x.name}
                </span>
              ))}
            </div>
            {m.reasons.map((r, i) => (
              <div key={r.id ?? "none"} role="row" className={s.hrow}>
                <span role="rowheader" className={s.rh} title={r.name}>
                  {r.name}
                </span>
                {m.sources.map((x, j) => {
                  const c = cell(r.id, x.id);
                  const n = c?.n ?? 0;
                  const k = n / max;
                  return (
                    <span key={x.id ?? "none"} role="cell">
                      <button
                        type="button"
                        className={s.cell}
                        disabled={!c?.drill || !n}
                        data-thin={c?.tooFew || undefined}
                        aria-label={`${r.name} from ${x.name}: ${count(n)} ${n === 1 ? "lead" : "leads"}`}
                        style={
                          {
                            "--d": i + j,
                            background: `rgba(229, 72, 77, ${(0.08 + k * 0.82).toFixed(2)})`,
                            color: k > 0.5 ? "#fff" : "var(--text)",
                          } as CSSProperties
                        }
                        onClick={() => c?.drill && onDrill(c.drill, `Lost: ${r.name}, from ${x.name}`)}
                      >
                        {count(n)}
                      </button>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
          <div className={s.scale2} aria-hidden>
            <span>Fewer</span>
            <i />
            <span>More</span>
          </div>
        </>
      )}
    </Card>
  );
}

function Stages({
  lost,
  insight,
  onDrill,
}: {
  lost: Lost;
  insight: { title: string; body: string } | undefined;
  onDrill(token: string, title: string): void;
}) {
  const max = Math.max(1, ...lost.stages.map((x) => x.n));
  return (
    <Card title="The stage they left at" sub="Where in the pipeline each one was">
      {!lost.stages.length ? (
        <p className={a.empty}>Nothing lost to place yet.</p>
      ) : (
        <div className={s.byst}>
          {lost.stages.slice(0, 8).map((x, i) => (
            <button
              key={x.id ?? "none"}
              type="button"
              className={s.bs}
              style={{ "--i": i } as CSSProperties}
              disabled={!x.drill}
              aria-label={`Lost at ${x.name}: ${count(x.n)}. See the leads.`}
              onClick={() => x.drill && onDrill(x.drill, `Lost at ${x.name}`)}
            >
              <span>{x.name}</span>
              <span className={s.tr7}>
                <i style={{ width: `${(x.n / max) * 100}%` }} />
              </span>
              <em>{count(x.n)}</em>
            </button>
          ))}
        </div>
      )}
      {insight && (
        <div className={s.ins}>
          <span className={s.spk} aria-hidden>
            <img src="/lume-mark.png" alt="" />
          </span>
          <div>
            <b>{insight.title}</b>
            <p>{insight.body}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

function WonBack({
  lost,
  rangeWords,
  currency,
  compare,
  onDrill,
}: {
  lost: Lost;
  rangeWords: string;
  currency: string;
  compare: boolean;
  onDrill(token: string, title: string): void;
}) {
  const f = lost.wonBackFlow;
  return (
    <Card title="Won back" sub={`Lost leads that came back ${rangeWords}: reopened, then won`}>
      <div className={s.wb}>
        <div className={s.wbs}>
          <b>{count(f.lost)}</b>
          <span>lost</span>
        </div>
        <div className={s.wbs}>
          <b>{count(f.reopened)}</b>
          <span>reopened{f.lost ? ` · ${pct(f.reopened / f.lost, 1)}` : ""}</span>
        </div>
        <button
          type="button"
          className={s.wbs}
          disabled={!f.drill || !f.won}
          aria-label={`Won back: ${count(f.won)}. See the leads.`}
          onClick={() => f.drill && onDrill(f.drill, "Won back")}
        >
          <b>{count(f.won)}</b>
          <span>won{f.reopened ? ` · ${pct(f.won / f.reopened)} of reopened` : ""}</span>
        </button>
      </div>
      {f.value !== undefined && (
        <div className={s.rec} data-none={!f.value || undefined}>
          <b>{money(f.value, currency)}</b>
          <span>recovered from leads once marked lost</span>
          {compare && f.trend && (
            <span className={s.recChip}>
              <Chip trend={f.trend} />
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

function Converts({
  params,
  rangeDays,
  onDrill,
}: {
  params: AnalyticsParams;
  rangeDays: number;
  onDrill(token: string, title: string): void;
}) {
  const [field, setField] = useState<string | null>(null);
  const [data, setData] = useState<Segments | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const tooLong = rangeDays > LIVE_DAYS;
  const key = JSON.stringify(params);
  useEffect(() => {
    if (tooLong) return;
    let live = true;
    setFailed(null);
    // Another range's answers never stand under this one's title while the new ones come.
    setData(null);
    void analyticsClient.segments(params, field ?? undefined).then((r) => {
      if (!live) return;
      if (!r.ok) return setFailed(r.message ?? "LUME couldn’t count these right now.");
      // No field chosen yet: the first one offered (choosing it reads its groups).
      if (!r.data.field && r.data.fields.length) return setField(r.data.fields[0]!.key);
      setData(r.data);
    });
    return () => {
      live = false;
    };
  }, [key, field, tooLong]); // params are read through `key`
  const fields = data?.fields ?? [];
  const groups = data?.groups ?? [];
  const best = Math.max(0, ...groups.filter((g) => !g.tooFew).map((g) => g.rate ?? 0));
  return (
    <Card
      title="What converts"
      sub="Won, out of leads with each answer · group by any field"
      right={
        fields.length > 1 ? (
          fields.length <= 3 ? (
            <SegmentedControl
              label="Group by"
              value={field ?? fields[0]!.key}
              options={fields.map((f) => ({ value: f.key, label: f.label }))}
              onChange={(v) => setField(v)}
            />
          ) : (
            <select
              className={s.pick}
              aria-label="Group by"
              value={field ?? fields[0]!.key}
              onChange={(e) => setField(e.target.value)}
            >
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          )
        ) : undefined
      }
    >
      {tooLong ? (
        <p className={a.empty}>
          Answers are counted from each lead, for up to 92 days. Pick a shorter range to see this.
        </p>
      ) : failed ? (
        <p className={a.empty}>{failed}</p>
      ) : !data ? (
        <Skeleton h={180} />
      ) : !fields.length ? (
        <p className={a.empty}>
          Add a choice or yes/no field (Settings → Fields) and LUME will show which answers win most often.
        </p>
      ) : !groups.length ? (
        <p className={a.empty}>No leads arrived in this range.</p>
      ) : (
        <div className={s.sgb}>
          {groups.map((g) => (
            <button
              key={g.value ?? "none"}
              type="button"
              className={s.sg}
              disabled={!g.drill}
              aria-label={`${g.label}: ${g.rate === null ? "no leads" : `${pct(g.rate, 1)} won`}, ${plural(g.arrived, "lead")}. See the leads.`}
              onClick={() => g.drill && onDrill(g.drill, `${data.field?.label ?? "Answer"}: ${g.label}`)}
            >
              <b>{g.label}</b>
              <span className={s.tr8}>
                <i
                  data-best={(!g.tooFew && g.rate !== null && g.rate === best && best > 0) || undefined}
                  style={{ width: `${best ? ((g.rate ?? 0) / best) * 100 : 0}%` }}
                />
              </span>
              <em>
                {g.tooFew ? <span className={s.thin}>Too few</span> : g.rate === null ? "—" : pct(g.rate, 1)}
              </em>
              <span className={s.r2}>
                {count(g.arrived)} {g.arrived === 1 ? "lead" : "leads"}
              </span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
