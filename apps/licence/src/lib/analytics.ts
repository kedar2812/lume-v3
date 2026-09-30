import type { LicenceType } from "@lume/core/shared";
import { monthlyInr, type Rates } from "./money";
import { utcDay } from "./state";

export const SOURCES = ["referrals", "demo", "website", "instagram", "other"] as const;
export type Source = (typeof SOURCES)[number];

/** A client as the analytics read it (from the database, or the canvas's fixture). */
export type AClient = {
  id: string;
  name: string;
  country: string;
  region: string | null;
  source: Source;
  type: LicenceType;
  createdAt: Date;
  /** When its monthly revenue began: at creation for a subscription, at the first payment for a trial. */
  payingSince: Date | null;
  /** Suspended or decommissioned: it left. */
  endedAt: Date | null;
  trialEnds: string | null;
  /** It began as a trial (counted by trial-to-paid). */
  trialStarted: boolean;
  /** Oldest first; a change of price adds one. */
  prices: { currency: string; amount: number; periodMonths: number; from: Date }[];
};

export type Idea = { key: "source" | "abroad" | "below" | "pace" | "down"; title: string; body: string };
export type Analytics = {
  range: 3 | 6 | 12;
  month: string;
  mrr: number;
  mrrBefore: number;
  arr: number;
  paying: number;
  payingBefore: number;
  joined: number;
  left: number;
  /** Average monthly growth over the range, compounded from its first month with revenue (0.44 = 44%). */
  growth: number;
  churn: number;
  churnBefore: number;
  lost: number;
  arpa: number;
  arpaBefore: number;
  ltv: number;
  ltvBefore: number;
  series: { month: string; mrr: number; joined: number; left: number }[];
  moves: { start: number; new: number; up: number; down: number; lost: number; now: number };
  countries: {
    all: { country: string; clients: number; mrrInr: number }[];
    fresh: { country: string; clients: number; mrrInr: number }[];
  };
  states: { all: { region: string; clients: number }[]; fresh: { region: string; clients: number }[] };
  currencies: { currency: string; mrrInr: number }[];
  abroadInr: number;
  sources: { source: Source; clients: number; paying: number; mrrInr: number }[];
  spread: { id: string; name: string; mrrInr: number }[];
  listPriceInr: number;
  belowList: number;
  trials: { started: number; bought: number; running: number; rate: number; rateBefore: number };
  ideas: Idea[];
  /** Currencies priced in with no rate known: left out of every rupee total, and named. */
  missingRates: string[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const keyOf = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
const monthLabel = (k: number) => `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;
const monthShort = (k: number) => MONTHS[k % 12]!;
const startOf = (k: number) => Date.UTC(Math.floor(k / 12), k % 12, 1);
const andList = (xs: string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? "");
const SOURCE_WORDS: Record<Source, string> = {
  referrals: "Referrals",
  demo: "Demo site visitors",
  website: "Website visitors",
  instagram: "Instagram",
  other: "Other sources",
};

/**
 * Every number on Analytics (spec §4.4, the canvas's AdminAnalytics), in rupees at today's rates. A month is
 * read at its end (this month: now): a client counts from the month it began paying, until the month it
 * left, at the price in effect then.
 */
export function computeAnalytics(o: {
  clients: AClient[];
  rates: Rates;
  now: Date;
  range: 3 | 6 | 12;
  listPriceInr: number;
}): Analytics {
  const { clients, rates, now, range: R } = o;
  const NOW = keyOf(now);
  const missing = new Set<string>();
  const at = (k: number) => Math.min(now.getTime(), startOf(k + 1) - 1);
  const monthOf = (d: Date | null) => (d ? keyOf(d) : null);

  const priceAt = (c: AClient, k: number): number => {
    const t = at(k);
    if (!c.payingSince || c.payingSince.getTime() > t) return 0;
    if (c.endedAt && c.endedAt.getTime() <= t) return 0;
    const p = [...c.prices].reverse().find((x) => x.from.getTime() <= t) ?? c.prices[0];
    if (!p || !p.periodMonths) return 0;
    const m = monthlyInr(p, rates);
    if (m === null) {
      missing.add(p.currency);
      return 0;
    }
    return m;
  };
  const mrrAt = (k: number) => clients.reduce((t, c) => t + priceAt(c, k), 0);
  const payingAt = (k: number) => clients.filter((c) => priceAt(c, k) > 0).length;
  const joinedIn = (k: number) =>
    clients.filter((c) => monthOf(c.payingSince) === k && priceAt(c, k) > 0).length;
  const leftIn = (k: number) =>
    clients.filter((c) => monthOf(c.endedAt) === k && priceAt(c, k - 1) > 0).length;

  const metricsAt = (end: number) => {
    const mrr = mrrAt(end);
    const paying = payingAt(end);
    let lost = 0;
    let base = 0;
    for (let k = end - R + 1; k <= end; k++) {
      lost += leftIn(k);
      base += payingAt(k - 1);
    }
    const churn = base ? lost / base : 0;
    const arpa = paying ? mrr / paying : 0;
    return { mrr, paying, lost, churn, arpa, ltv: churn > 0 ? arpa / churn : 0 };
  };

  const series: Analytics["series"] = [];
  for (let k = NOW - R; k <= NOW; k++)
    series.push({ month: monthLabel(k), mrr: mrrAt(k), joined: joinedIn(k), left: leftIn(k) });
  const m = metricsAt(NOW);
  const was = metricsAt(NOW - 1);
  const mrr = m.mrr;
  const mrrBefore = mrrAt(NOW - 1);

  const firstAt = series.findIndex((p) => p.mrr > 0);
  const months = firstAt >= 0 ? series.length - 1 - firstAt : 0;
  const growth =
    months > 0 && mrr > 0 ? (mrr / series[firstAt]!.mrr) ** (1 / months) - 1 : months > 0 ? -1 : 0;

  // What moved it: new, price rises and cuts, lost — each month of the range against the one before.
  const moves = { start: mrrAt(NOW - R), new: 0, up: 0, down: 0, lost: 0, now: mrr };
  for (let k = NOW - R + 1; k <= NOW; k++) {
    for (const c of clients) {
      if (!c.payingSince) continue;
      const a = priceAt(c, k - 1);
      const b = priceAt(c, k);
      if (monthOf(c.payingSince) === k) moves.new += b;
      else if (monthOf(c.endedAt) === k) moves.lost += a;
      else if (a && b && b > a) moves.up += b - a;
      else if (a && b && b < a) moves.down += a - b;
    }
  }

  const current = clients.filter((c) => !c.endedAt || c.endedAt.getTime() > now.getTime());
  const fresh = current.filter((c) => keyOf(c.createdAt) > NOW - R);
  const byCountry = (cs: AClient[]) => {
    const g = new Map<string, { country: string; clients: number; mrrInr: number }>();
    for (const c of cs) {
      const x = g.get(c.country) ?? { country: c.country, clients: 0, mrrInr: 0 };
      x.clients++;
      x.mrrInr += priceAt(c, NOW);
      g.set(c.country, x);
    }
    return [...g.values()].sort(
      (a, b) => b.clients - a.clients || b.mrrInr - a.mrrInr || a.country.localeCompare(b.country),
    );
  };
  const byState = (cs: AClient[]) => {
    const g = new Map<string, number>();
    for (const c of cs) if (c.country === "IN" && c.region) g.set(c.region, (g.get(c.region) ?? 0) + 1);
    return [...g.entries()]
      .map(([region, n]) => ({ region, clients: n }))
      .sort((a, b) => b.clients - a.clients || a.region.localeCompare(b.region));
  };

  const byCur = new Map<string, number>();
  for (const c of clients) {
    const v = priceAt(c, NOW);
    if (!v) continue;
    const t = at(NOW);
    const p = [...c.prices].reverse().find((x) => x.from.getTime() <= t) ?? c.prices[0]!;
    byCur.set(p.currency, (byCur.get(p.currency) ?? 0) + v);
  }
  const currencies = [...byCur.entries()]
    .map(([currency, mrrInr]) => ({ currency, mrrInr }))
    .sort((a, b) => b.mrrInr - a.mrrInr);
  const abroadInr = clients.filter((c) => c.country !== "IN").reduce((t, c) => t + priceAt(c, NOW), 0);

  const bySrc = new Map<Source, { source: Source; clients: number; paying: number; mrrInr: number }>();
  for (const c of current) {
    const x = bySrc.get(c.source) ?? { source: c.source, clients: 0, paying: 0, mrrInr: 0 };
    const v = priceAt(c, NOW);
    x.clients++;
    x.mrrInr += v;
    if (v) x.paying++;
    bySrc.set(c.source, x);
  }
  const sources = [...bySrc.values()].sort((a, b) => b.mrrInr - a.mrrInr || b.clients - a.clients);

  const spread = clients
    .map((c) => ({ id: c.id, name: c.name, mrrInr: priceAt(c, NOW) }))
    .filter((p) => p.mrrInr > 0)
    .sort((a, b) => a.mrrInr - b.mrrInr);
  const belowList = o.listPriceInr > 0 ? spread.filter((p) => p.mrrInr < o.listPriceInr - 0.5).length : 0;

  // Trial to paid: bought over the trials that have finished (a running trial hasn't decided yet).
  const trialsAt = (when: Date) => {
    const t = when.getTime();
    const day = utcDay(when);
    const started = clients.filter((c) => c.trialStarted && c.createdAt.getTime() <= t);
    const bought = started.filter((c) => c.payingSince && c.payingSince.getTime() <= t).length;
    const running = started.filter(
      (c) =>
        !(c.payingSince && c.payingSince.getTime() <= t) &&
        !(c.endedAt && c.endedAt.getTime() <= t) &&
        !!c.trialEnds &&
        c.trialEnds >= day,
    ).length;
    const done = started.length - running;
    return { started: started.length, bought, running, rate: done ? bought / done : 0 };
  };
  const monthAgo = new Date(now);
  monthAgo.setUTCMonth(monthAgo.getUTCMonth() - 1);
  const tNow = trialsAt(now);
  const trials = { ...tNow, rateBefore: trialsAt(monthAgo).rate };

  // Ideas to grow, from the numbers above (the canvas's four).
  const ideas: Idea[] = [];
  if (mrr > 0) {
    const top = sources[0];
    if (top && top.mrrInr > 0)
      ideas.push({
        key: "source",
        title: `${SOURCE_WORDS[top.source]} bring ${Math.round((top.mrrInr / mrr) * 100)}% of your revenue`,
        body:
          top.source === "referrals"
            ? "Ask your happiest clients for an introduction. It's your best-paying channel."
            : "It's your best-paying channel: worth more of your time.",
      });
    const payingNow = clients.filter((c) => priceAt(c, NOW) > 0);
    const indian = payingNow.filter((c) => c.country === "IN");
    const foreign = payingNow.filter((c) => c.country !== "IN");
    const avg = (cs: AClient[]) => cs.reduce((t, c) => t + priceAt(c, NOW), 0) / Math.max(1, cs.length);
    if (indian.length && foreign.length && avg(foreign) > avg(indian))
      ideas.push({
        key: "abroad",
        title: `Clients abroad pay ${(avg(foreign) / avg(indian)).toFixed(1)}× more a month`,
        body: `${foreign.length} of ${payingNow.length} paying clients are outside India. Worth pitching further.`,
      });
    if (belowList)
      ideas.push({
        key: "below",
        title: `${belowList} ${belowList === 1 ? "client pays" : "clients pay"} below your list price`,
        body: "Their next renewal is a fair moment to move them up.",
      });
    const three = mrrAt(NOW - 3);
    const g3 = three > 0 ? (mrr / three) ** (1 / 3) - 1 : 0;
    if (g3 < 0 && mrrBefore > 0) {
      const leftNow = clients
        .filter((c) => monthOf(c.endedAt) === NOW && priceAt(c, NOW - 1) > 0)
        .map((c) => c.name);
      ideas.push({
        key: "down",
        title: `Revenue is down ${Math.abs(Math.round(((mrr - mrrBefore) / mrrBefore) * 100))}% on ${monthShort(NOW - 1)}`,
        body: leftNow.length
          ? `${andList(leftNow)} left this month. A call may win them back, or tell you why.`
          : "Fewer clients paid this month.",
      });
    } else if (g3 > 0 && mrr < 100000) {
      const toLakh = Math.ceil(Math.log(100000 / mrr) / Math.log(1 + g3));
      const trial = clients.find(
        (c) => c.type === "trial" && c.trialEnds && c.trialEnds >= utcDay(now) && !c.endedAt,
      );
      ideas.push({
        key: "pace",
        title: `₹1 lakh a month in about ${toLakh} ${toLakh === 1 ? "month" : "months"}`,
        body: trial
          ? `At the last 3 months' pace. ${trial.name}'s trial ends ${Number(trial.trialEnds!.slice(8))} ${MONTHS[Number(trial.trialEnds!.slice(5, 7)) - 1]}, so a call this week helps.`
          : "At the last 3 months' pace.",
      });
    }
  }

  return {
    range: R,
    month: monthLabel(NOW),
    mrr,
    mrrBefore,
    arr: mrr * 12,
    paying: m.paying,
    payingBefore: payingAt(NOW - 1),
    joined: joinedIn(NOW),
    left: leftIn(NOW),
    growth,
    churn: m.churn,
    churnBefore: was.churn,
    lost: m.lost,
    arpa: m.arpa,
    arpaBefore: was.arpa,
    ltv: m.ltv,
    ltvBefore: was.ltv,
    series,
    moves,
    countries: { all: byCountry(current), fresh: byCountry(fresh) },
    states: { all: byState(current), fresh: byState(fresh) },
    currencies,
    abroadInr,
    sources,
    spread,
    listPriceInr: o.listPriceInr,
    belowList,
    trials,
    ideas,
    missingRates: [...missing].sort(),
  };
}
