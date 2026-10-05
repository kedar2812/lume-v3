"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { analyticsClient, type SourceRow } from "@/lib/analytics/client";
import { count, money } from "@/lib/analytics/words";
import s from "./spend.module.css";

export type SpendSource = {
  id: string;
  name: string;
  type: string;
  status: string;
  monthlySpend: number | null;
};
const KIND: Record<string, string> = {
  csv: "File import",
  google_sheet: "Google Sheet",
  webhook: "Webhook",
  manual: "Added by hand",
  calendly: "Calendly",
};
const grouped = (v: number | null, currency: string) =>
  v === null ? "" : v.toLocaleString(currency === "INR" ? "en-IN" : "en-US", { maximumFractionDigits: 2 });
/** A month's spend counted for 30 days, the way Analytics spreads it over a range. */
const PER_30 = 30 / (365.25 / 12);
const amount = (raw: string): number | null | "bad" => {
  const t = raw.replace(/[,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 1e12 ? Math.round(n * 100) / 100 : "bad";
};

/**
 * Settings → Sources & spend (8D-3, the approved Spend board): what each source costs a month. Analytics then shows
 * what a lead costs from it and what every unit spent brings back in revenue won; here the same, as you type, from
 * the last 30 days.
 */
export function SpendEditor({
  initial,
  currency,
  seesMoney,
}: {
  initial: SpendSource[];
  currency: string;
  seesMoney: boolean;
}) {
  const [rows, setRows] = useState(initial);
  const [text, setText] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.map((x) => [x.id, grouped(x.monthlySpend, currency)])),
  );
  const [state, setState] = useState<Record<string, "saving" | "saved" | "error">>({});
  const [stats, setStats] = useState<Map<string | null, SourceRow> | null>(null);
  useEffect(() => {
    void analyticsClient.sources({ range: "30d", compare: false }).then((r) => {
      if (r.ok) setStats(new Map(r.data.sources.map((x) => [x.id, x])));
    });
  }, []);

  const save = async (id: string) => {
    const v = amount(text[id] ?? "");
    if (v === "bad") return setState((x) => ({ ...x, [id]: "error" }));
    if (v === rows.find((x) => x.id === id)?.monthlySpend) return;
    setState((x) => ({ ...x, [id]: "saving" }));
    const r = await api.put<{ id: string; monthlySpend: number | null }>(
      `/api/v1/settings/sources/${id}/spend`,
      {
        monthlySpend: v,
      },
    );
    setState((x) => ({ ...x, [id]: r.ok ? "saved" : "error" }));
    if (r.ok) {
      setRows((xs) => xs.map((x) => (x.id === id ? { ...x, monthlySpend: v } : x)));
      setText((t) => ({ ...t, [id]: grouped(v, currency) }));
    }
  };

  // As typed: each source's spend, and what follows from the last 30 days.
  const typed = (id: string) => {
    const v = amount(text[id] ?? "");
    return typeof v === "number" ? v : null;
  };
  const paid = rows.filter((x) => (typed(x.id) ?? 0) > 0);
  const totalSpend = paid.reduce((a, x) => a + typed(x.id)!, 0);
  const paidLeads = paid.reduce((a, x) => a + (stats?.get(x.id)?.leads ?? 0), 0);
  const paidRevenue = paid.reduce((a, x) => a + (stats?.get(x.id)?.revenue ?? 0), 0);
  const cplAll = paidLeads ? (totalSpend * PER_30) / paidLeads : null;
  const roiAll = totalSpend && seesMoney ? paidRevenue / (totalSpend * PER_30) : null;
  const ratio = (x: number) => `${x.toFixed(1).replace(/\.0$/, "")}×`;
  const best = paid
    .map((x) => {
      const st = stats?.get(x.id);
      return st && st.revenue !== undefined
        ? { name: x.name, roi: st.revenue / (typed(x.id)! * PER_30) }
        : null;
    })
    .filter((x): x is { name: string; roi: number } => !!x)
    .sort((p, q) => q.roi - p.roi);

  return (
    <div className={s.wrap}>
      <div className={s.kpis}>
        <div className={s.kpi}>
          <span>Spend a month</span>
          <b>{money(totalSpend, currency)}</b>
          <small>
            {paid.length} paid {paid.length === 1 ? "source" : "sources"}
          </small>
        </div>
        <div className={s.kpi}>
          <span>What a lead costs, paid sources</span>
          <b>{cplAll === null ? "—" : money(cplAll, currency, false)}</b>
          <small>From the last 30 days&rsquo; leads</small>
        </div>
        {seesMoney && (
          <div className={s.kpi}>
            <span>Revenue won per {currency} 1 spent</span>
            <b>{roiAll === null ? "—" : ratio(roiAll)}</b>
            <small>Paid sources, last 30 days</small>
          </div>
        )}
      </div>

      <section className={s.card} aria-label="Each source">
        <div className={s.head}>
          <h2>Each source</h2>
          <span>
            Its leads, wins and revenue in the last 30 days, its monthly spend, and what follows from it ·{" "}
            <Link href="/analytics?m=revenue">See it on Analytics</Link>
          </span>
        </div>
        {!rows.length ? (
          <p className={s.empty}>No sources yet. Import a file or connect a sheet, and it shows here.</p>
        ) : (
          <div className={s.scroll}>
            <table className={s.st}>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Leads · 30 days</th>
                  <th scope="col">Won</th>
                  {seesMoney && <th scope="col">Revenue won</th>}
                  <th scope="col">Spend a month</th>
                  <th scope="col">Cost per lead</th>
                  {seesMoney && <th scope="col">Per {currency} 1 spent</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => {
                  const st = stats?.get(x.id);
                  const sp = typed(x.id);
                  const cpl = sp && st?.leads ? (sp * PER_30) / st.leads : null;
                  const roi =
                    sp && seesMoney && st?.revenue !== undefined ? st.revenue / (sp * PER_30) : null;
                  return (
                    <tr key={x.id}>
                      <td>
                        <b>{x.name}</b>
                        <span className={s.kind}>{KIND[x.type] ?? "Source"}</span>
                      </td>
                      <td>{st ? count(st.leads) : "—"}</td>
                      <td>{st ? count(st.won) : "—"}</td>
                      {seesMoney && <td>{st?.revenue !== undefined ? money(st.revenue, currency) : "—"}</td>}
                      <td>
                        <span className={s.box} data-state={state[x.id]}>
                          <span className={s.cur}>{currency}</span>
                          <input
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder="Free"
                            aria-label={`${x.name}: spend a month`}
                            aria-invalid={state[x.id] === "error" || undefined}
                            value={text[x.id] ?? ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              setText((t) => ({ ...t, [x.id]: v }));
                              setState((t) => {
                                const n = { ...t };
                                delete n[x.id];
                                return n;
                              });
                            }}
                            onBlur={() => void save(x.id)}
                            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                          />
                        </span>
                      </td>
                      <td>{cpl === null ? "—" : money(cpl, currency, false)}</td>
                      {seesMoney && (
                        <td>
                          {roi === null ? (
                            <span className={s.dim}>{sp ? "—" : "Free"}</span>
                          ) : (
                            <span className={s.roi} data-tone={roi >= 3 ? "hi" : roi < 1 ? "lo" : "mid"}>
                              {ratio(roi)}
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {seesMoney && best.length > 0 && (
          <div className={s.ins}>
            <span className={s.spk} aria-hidden>
              <img src="/lume-mark.png" alt="" />
            </span>
            <div>
              <b>
                {best[0]!.name} brings back {ratio(best[0]!.roi)} what it costs
              </b>
              <p>
                {best.length > 1
                  ? `${best.at(-1)!.name} brings back ${ratio(best.at(-1)!.roi)}.`
                  : "It's your only paid source with revenue so far."}
              </p>
            </div>
          </div>
        )}
        <p className={s.note}>
          Spread over any range: for a 7-day range, Analytics counts 7 days&rsquo; share of the month&rsquo;s
          spend. Change the amount when your budget changes.
        </p>
      </section>
    </div>
  );
}
