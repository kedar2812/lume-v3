"use client";
import type { CSSProperties } from "react";
import type { Funnel, Lost, Quality, Sources, Team, Templates, Timing } from "@/lib/analytics/client";
import { count, minutes, money, pct } from "@/lib/analytics/words";
import { Avatar } from "@/components/ui/Avatar";
import { FunnelBars } from "./Overview";
import { Card, Chip, Skeleton } from "./parts";
import s from "./analytics.module.css";

const loading = (
  <div aria-busy="true" className={s.grid2} style={{ marginTop: 0 }}>
    <Skeleton h={320} />
    <Skeleton h={320} i={2} />
  </div>
);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const rate = (x: number | null, places = 0) => (x === null ? "—" : pct(x, places));

/** Funnel (canvas Funnel): how far the range's leads got, stage by stage, and where most of them stopped. */
export function FunnelBoard({ funnel, rangeWords }: { funnel: Funnel | null; rangeWords: string }) {
  if (!funnel) return loading;
  const worst = funnel.stages
    .filter((x) => x.kind !== "won" && x.reached >= 10 && x.stopped !== null)
    .sort((a, b) => b.stopped! - a.stopped!)[0];
  return (
    <div className={s.grid2} style={{ marginTop: 0 }}>
      <Card title="The funnel" sub={`Of the ${count(funnel.arrived)} leads that arrived ${rangeWords}`}>
        <FunnelBars funnel={funnel} />
      </Card>
      <Card title="Stage by stage" sub="Reached it or a later stage, against the period before">
        <table className={s.table}>
          <thead>
            <tr>
              <th>Stage</th>
              <th>Reached</th>
              <th>Share</th>
              <th>Change</th>
              <th>Stopped there</th>
            </tr>
          </thead>
          <tbody>
            {funnel.stages.map((st) => (
              <tr key={st.id} data-thin={st.tooFew || undefined}>
                <td>{st.name}</td>
                <td>{count(st.reached)}</td>
                <td>{rate(st.share)}</td>
                <td>{st.tooFew ? <span className={s.thin}>Too few</span> : <Chip trend={st.trend} />}</td>
                <td>{st.kind === "won" ? "—" : rate(st.stopped)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {worst && (
          <p className={s.sub} style={{ marginTop: 12 }}>
            Most leads stop at {worst.name}: {pct(worst.stopped!)} of those that reached it went no further.
          </p>
        )}
      </Card>
    </div>
  );
}

/** Team (canvas Team): each person's numbers side by side, for someone who sees more than themselves. */
export function TeamBoard({ team, currency }: { team: Team | null; currency: string }) {
  if (!team) return loading;
  const money_ = team.people.some((p) => p.revenueWon !== undefined);
  return (
    <Card
      title={team.leaderboard ? "Each person" : "Your numbers"}
      sub={team.leaderboard ? "Credited to whoever owned the lead at the time" : "Credited to you"}
    >
      {team.people.length === 0 ? (
        <p className={s.empty}>No activity in this range yet.</p>
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Person</th>
              <th>New leads</th>
              <th>Contacted</th>
              <th>Speed to lead</th>
              <th>Won</th>
              {money_ && <th>Revenue won</th>}
              <th>On time</th>
              <th>Overdue now</th>
            </tr>
          </thead>
          <tbody>
            {team.people.map((p) => (
              <tr key={p.id}>
                <td>
                  <span className={s.person}>
                    <Avatar name={p.name} size={26} />
                    {p.name}
                    {!p.active && <span className={s.thin}>(left)</span>}
                  </span>
                </td>
                <td>{count(p.newLeads)}</td>
                <td>{rate(p.contacted)}</td>
                <td>{p.speedToLead === null ? "—" : minutes(p.speedToLead)}</td>
                <td>{count(p.won)}</td>
                {money_ && <td>{money(p.revenueWon ?? 0, currency)}</td>}
                <td>{rate(p.ontime)}</td>
                <td style={p.overdueNow ? { color: "var(--danger-ink)", fontWeight: 650 } : undefined}>
                  {count(p.overdueNow)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** Revenue and sources (canvas Revenue): where leads come from, how many are won, the money, and what they cost. */
export function SourcesBoard({ sources, currency }: { sources: Sources | null; currency: string }) {
  if (!sources) return loading;
  const showMoney = sources.sources.some((x) => x.revenue !== undefined);
  return (
    <Card
      title="Sources"
      sub="Leads that arrived in the range, how many are won so far, and revenue won from them"
    >
      {sources.sources.length === 0 ? (
        <p className={s.empty}>No leads arrived in this range.</p>
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Source</th>
              <th>Leads</th>
              <th>Share</th>
              <th>Win rate</th>
              {showMoney && (
                <>
                  <th>Revenue</th>
                  <th>Spend</th>
                  <th>Per lead</th>
                  <th>Return</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {sources.sources.map((x) => (
              <tr key={x.id ?? "none"} data-thin={x.tooFew || undefined}>
                <td>{x.name}</td>
                <td>{count(x.leads)}</td>
                <td>{rate(x.leadShare)}</td>
                <td>{x.tooFew ? <span className={s.thin}>Too few</span> : rate(x.winRate, 1)}</td>
                {showMoney && (
                  <>
                    <td>{money(x.revenue ?? 0, currency)}</td>
                    <td>
                      {x.spend === null || x.spend === undefined ? (
                        <span className={s.thin}>Not set</span>
                      ) : (
                        money(x.spend, currency)
                      )}
                    </td>
                    <td>{x.costPerLead == null ? "—" : money(x.costPerLead, currency)}</td>
                    <td>{x.returnPerSpent == null ? "—" : `${x.returnPerSpent.toFixed(1)}×`}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showMoney && (
        <p className={s.sub} style={{ marginTop: 10 }}>
          Spend is the month’s amount spread over the range’s days. Set it in Settings → Sources.
        </p>
      )}
    </Card>
  );
}

/** Lost (canvas Lost): why leads were lost, from which stage, and those won back. */
export function LostBoard({ lost, currency }: { lost: Lost | null; currency: string }) {
  if (!lost) return loading;
  const most = Math.max(1, ...lost.reasons.map((r) => r.n));
  return (
    <div className={s.grid2} style={{ marginTop: 0 }}>
      <Card title="Why they were lost" sub={`${count(lost.total)} lost in the range`}>
        {lost.reasons.length === 0 ? (
          <p className={s.empty}>No leads were lost in this range.</p>
        ) : (
          <div className={s.funnel}>
            {lost.reasons.map((r, i) => (
              <div key={r.id ?? "none"} className={s.stage} style={{ cursor: "default" }}>
                <span className={s.stageName} title={r.name}>
                  {r.name}
                </span>
                <span className={s.track}>
                  <span
                    className={s.fill}
                    style={
                      {
                        width: `${Math.max(4, (r.n / most) * 100)}%`,
                        background: "var(--danger)",
                        "--i": i,
                      } as CSSProperties
                    }
                  >
                    <b>{count(r.n)}</b>
                  </span>
                </span>
                <span className={s.share}>{rate(r.share)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title="The stage they left" sub="Where each lost lead was just before">
        <div className={s.list}>
          {lost.stages.map((st) => (
            <div
              key={st.id ?? "none"}
              className={s.item}
              style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}
            >
              <b>{st.name}</b>
              <span className={s.num}>{count(st.n)}</span>
            </div>
          ))}
        </div>
        <p className={s.sub} style={{ marginTop: 12 }}>
          Won back: {count(lost.wonBack.n)} {lost.wonBack.n === 1 ? "lead" : "leads"} once lost were reopened
          and won
          {lost.wonBack.value !== undefined && lost.wonBack.n
            ? `, worth ${money(lost.wonBack.value, currency)}`
            : ""}
          .
        </p>
      </Card>
    </div>
  );
}

/** Timing (canvas Timing): when leads arrive and reply, which booking slots hold, and how long each stage takes. */
export function TimingBoard({ timing }: { timing: Timing | null }) {
  if (!timing) return loading;
  const most = Math.max(1, ...timing.arrivals.flat());
  const heat = (
    title: string,
    sub: string,
    cell: (d: number, h: number) => { v: number; thin?: boolean; label: string },
  ) => (
    <Card title={title} sub={sub}>
      <div className={s.heat} role="table" aria-label={title}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h}>{h % 6 === 0 ? `${((h + 11) % 12) + 1}${h < 12 ? "a" : "p"}` : ""}</span>
        ))}
        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
          <div key={d} style={{ display: "contents" }} role="row">
            <span role="rowheader">{DAYS[d]}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const c = cell(d, h);
              return (
                <i
                  key={h}
                  role="cell"
                  className={s.cell}
                  data-thin={c.thin || undefined}
                  style={{ "--v": c.v } as CSSProperties}
                  title={c.label}
                />
              );
            })}
          </div>
        ))}
      </div>
    </Card>
  );
  return (
    <>
      <div className={s.grid2} style={{ marginTop: 0 }}>
        {heat("When leads arrive", "By weekday and hour, in the business’s time", (d, h) => {
          const n = timing.arrivals[d]?.[h] ?? 0;
          return { v: n / most, label: `${DAYS[d]} ${h}:00 — ${count(n)} leads` };
        })}
        {heat("When leads reply", "Messages answered within 3 days, by when they were sent", (d, h) => {
          const c = timing.replies[d]?.[h];
          return c?.rate === null || !c
            ? { v: 0, thin: (c?.n ?? 0) > 0, label: `${DAYS[d]} ${h}:00 — too few to say` }
            : { v: c.rate, label: `${DAYS[d]} ${h}:00 — ${pct(c.rate)} of ${count(c.n)} messages` };
        })}
      </div>
      <div className={s.grid2}>
        <Card
          title="Time in each stage"
          sub="How long leads stayed before moving on (median, and 3 in 4 within)"
        >
          <table className={s.table}>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Moved on</th>
                <th>Median</th>
                <th>3 in 4 within</th>
                <th>Stuck now</th>
              </tr>
            </thead>
            <tbody>
              {timing.stages.map((st) => (
                <tr key={st.id} data-thin={st.tooFew || undefined}>
                  <td>{st.name}</td>
                  <td>{count(st.exited)}</td>
                  <td>{st.medianMinutes === null ? "—" : minutes(st.medianMinutes)}</td>
                  <td>{st.p75Minutes === null ? "—" : minutes(st.p75Minutes)}</td>
                  <td>{count(st.stuckNow)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        {heat("Best booking slots", "Calls held out of those booked, by when they were set", (d, h) => {
          const c = timing.booking[d]?.[h];
          return c?.rate === null || !c
            ? { v: 0, thin: (c?.n ?? 0) > 0, label: `${DAYS[d]} ${h}:00 — too few to say` }
            : { v: c.rate, label: `${DAYS[d]} ${h}:00 — ${pct(c.rate)} of ${count(c.n)} calls held` };
        })}
      </div>
    </>
  );
}

/** Templates and data (canvas Quality): which messages get answered, and what needs tidying. */
export function QualityBoard({
  quality,
  templates,
}: {
  quality: Quality | null;
  templates: Templates | null;
}) {
  if (!quality || !templates) return loading;
  return (
    <div className={s.grid2} style={{ marginTop: 0 }}>
      <Card title="Templates" sub="Messages confirmed sent in the range; a reply within 3 days counts">
        {templates.templates.length === 0 ? (
          <p className={s.empty}>No template messages were sent in this range.</p>
        ) : (
          <table className={s.table}>
            <thead>
              <tr>
                <th>Template</th>
                <th>Sent</th>
                <th>Replies</th>
                <th>Reply rate</th>
                <th>Won within 30 days</th>
              </tr>
            </thead>
            <tbody>
              {templates.templates.map((t) => (
                <tr key={t.id} data-thin={t.tooFew || undefined}>
                  <td>{t.name}</td>
                  <td>{count(t.sends)}</td>
                  <td>{count(t.replies)}</td>
                  <td>{t.tooFew ? <span className={s.thin}>Too few</span> : rate(t.replyRate)}</td>
                  <td>{count(t.wins)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Data that needs a look" sub="Right now">
        <div className={s.list}>
          {[
            ["Numbers that need a country", quality.phoneNeedsCountry],
            ["Numbers LUME can’t read", quality.phoneInvalid],
            ["Nobody yet, under an hour", quality.unowned.under1h],
            ["Nobody yet, under a day", quality.unowned.under1d],
            ["Nobody yet, over a day", quality.unowned.over1d],
          ].map(([label, n]) => (
            <div
              key={label as string}
              className={s.item}
              style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}
            >
              <b>{label}</b>
              <span className={s.num}>{count(n as number)}</span>
            </div>
          ))}
          {quality.importsRejected.map((i) => (
            <div key={i.source_id} className={s.item} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
              <b>Rows {i.name} couldn’t take</b>
              <span className={s.num}>{count(i.errors + i.skipped)}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
