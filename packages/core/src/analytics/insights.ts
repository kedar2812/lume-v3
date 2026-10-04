import { SIGNIFICANT, twoProportion } from "./stats";

/**
 * "LUME noticed" (spec §6): each detector is a pure function over numbers the API has already gathered. A detector
 * speaks only with enough data, a real difference (p < 0.05) and a difference worth saying (its minimum effect),
 * and then only in its own hand-written words. Nothing here guesses: an estimate says so ("At this pace").
 */
export type DetectorId =
  | "speed_pays"
  | "source_over"
  | "source_under"
  | "reply_window"
  | "followups_slip"
  | "rep_support"
  | "weekday_late"
  | "stage_drop"
  | "lost_reason_up"
  | "template_best"
  | "won_back"
  | "evening_arrivals"
  | "goal_pace"
  | "slot_noshow";

export type Insight = {
  id: DetectorId;
  /** What it's about (a source id, a person, a slot…): with the id, the cooldown key. */
  subject: string;
  title: string;
  body: string;
  /** How big the finding is (a ratio, points, a count), for the cooldown's "moved by half". */
  magnitude: number;
  /** For ranking: about how many more wins (or leads kept) closing the gap would bring. */
  impact: number;
};

export type Window = { day: number; hour: number }; // a 2-hour window starting at `hour` on `day` (0 = Sunday)
export type InsightContext = {
  /** "team": worded for a business; "own": for one person ("Your…"). */
  view: "team" | "own";
  money: (n: number) => string | null;
  speed?: { fastN: number; fastWon: number; slowN: number; slowWon: number; medianMinutes: number | null };
  sources?: { id: string; name: string; leads: number; won: number; revenue: number; spend: number | null }[];
  replyWindows?: (Window & { sends: number; replies: number })[];
  followups?: {
    nowDone: number;
    nowOnTime: number;
    beforeDone: number;
    beforeOnTime: number;
    overdue: number;
    overdueBy: { name: string; n: number }[];
  };
  people?: { id: string; name: string; done: number; onTime: number; lateByWeekday: number[] }[];
  stages?: {
    id: string;
    name: string;
    reached: number;
    stopped: number;
    prevReached: number;
    prevStopped: number;
  }[];
  lostReasons?: { id: string; name: string; now: number; before: number }[];
  templates?: { id: string; name: string; sends: number; replies: number }[];
  wonBack?: { n: number; value: number };
  goal?: {
    metricWords: string;
    month: string;
    value: number;
    target: number;
    elapsed: number;
    daysLeft: number;
    shown: (n: number) => string;
  };
  slots?: (Window & { booked: number; noShow: number })[];
  arrivals?: { total: number; afterHours: number; after: string; contactBefore?: string; evidence: boolean };
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const pct = (x: number) => `${Math.round(x * 100)}%`;
export function duration(min: number): string {
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  if (min < 1440) {
    const h = Math.floor(min / 60);
    const m = Math.round(min - h * 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.round(min / 1440);
  return `${d} ${d === 1 ? "day" : "days"}`;
}
/** An hour of the day in words: "9 am", "6 pm". */
export const hour12 = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? " am" : " pm"}`;
const windowWords = (w: Window) => `${hour12(w.hour).replace(/ (am|pm)$/, "")}–${hour12((w.hour + 2) % 24)}`;
/** "Dev's and Leo's", "Dev's, Leo's and one other's", "Dev's, Leo's and 3 others'". */
export function possessives(names: string[]): string {
  const p = names.map((n) => `${n}’s`);
  if (p.length <= 2) return p.join(" and ");
  const rest = p.length - 2;
  return `${p[0]}, ${p[1]} and ${rest === 1 ? "one other’s" : `${rest} others’`}`;
}
const real = (a: number, n1: number, b: number, n2: number) => twoProportion(a, n1, b, n2).p < SIGNIFICANT;

type Detector = (c: InsightContext) => Insight | Insight[] | null;

const speedPays: Detector = ({ speed, view }) => {
  if (!speed || speed.fastN < 30 || speed.slowN < 30) return null;
  const fast = speed.fastWon / speed.fastN;
  const slow = speed.slowWon / speed.slowN;
  if (!slow || fast / slow < 1.5 || !real(speed.fastWon, speed.fastN, speed.slowWon, speed.slowN))
    return null;
  const ratio = fast / slow;
  const median = speed.medianMinutes;
  const yours = view === "own" ? "Your" : "Your";
  const tail =
    median === null
      ? ""
      : median > 60
        ? ` ${yours} median first contact is ${duration(median)}, so most leads miss that hour.`
        : ` ${yours} median first contact is ${duration(median)}.`;
  return {
    id: "speed_pays",
    subject: "all",
    title: "Speed pays off",
    body: `Leads contacted within an hour were won ${ratio.toFixed(1)} times as often.${tail}`,
    magnitude: ratio,
    impact: (fast - slow) * speed.slowN,
  };
};

const sourceOver: Detector = ({ sources, money }) => {
  if (!sources?.length) return null;
  const leads = sources.reduce((a, s) => a + s.leads, 0);
  const revenue = sources.reduce((a, s) => a + s.revenue, 0);
  if (!leads || !revenue || money(1) === null) return null;
  const out: Insight[] = [];
  for (const s of sources) {
    const leadShare = s.leads / leads;
    const revShare = s.revenue / revenue;
    if (s.won < 10 || leadShare < 0.05 || revShare < 1.5 * leadShare) continue;
    out.push({
      id: "source_over",
      subject: s.id,
      title: `${s.name} punches above its weight`,
      body: `It brings ${pct(leadShare)} of leads and ${pct(revShare)} of revenue won.`,
      magnitude: revShare / leadShare,
      impact: s.won * (revShare / leadShare - 1),
    });
  }
  return out;
};

const sourceUnder: Detector = ({ sources, money }) => {
  if (!sources?.length) return null;
  const out: Insight[] = [];
  for (const s of sources) {
    if (s.leads < 100 || s.spend === null) continue;
    const restN = sources.reduce((a, x) => a + (x.id === s.id ? 0 : x.leads), 0);
    const restWon = sources.reduce((a, x) => a + (x.id === s.id ? 0 : x.won), 0);
    if (!restN) continue;
    const a = s.won / s.leads;
    const b = restWon / restN;
    if (!b || a > b * 0.6 || !real(s.won, s.leads, restWon, restN)) continue;
    const cpl = money(s.spend / s.leads);
    out.push({
      id: "source_under",
      subject: s.id,
      title: `${s.name} costs more than it returns`,
      body: `${cpl ? `${cpl} a lead, and its` : "Its"} leads are won ${pct(a)} of the time, against ${pct(b)} for the rest.`,
      magnitude: b / Math.max(a, 1e-9),
      impact: (b - a) * s.leads,
    });
  }
  return out;
};

const replyWindow: Detector = ({ replyWindows }) => {
  if (!replyWindows?.length) return null;
  const sends = replyWindows.reduce((a, w) => a + w.sends, 0);
  const replies = replyWindows.reduce((a, w) => a + w.replies, 0);
  let best: Insight | null = null;
  for (const w of replyWindows) {
    if (w.day === 0 || w.day === 6 || w.sends < 40) continue;
    const restN = sends - w.sends;
    const restR = replies - w.replies;
    if (restN < 200) continue;
    const a = w.replies / w.sends;
    const b = restR / restN;
    if (a - b < 0.1 || !real(w.replies, w.sends, restR, restN)) continue;
    const found: Insight = {
      id: "reply_window",
      subject: `${w.day}:${w.hour}`,
      title: `${DAYS[w.day]}s ${windowWords(w)} get the most replies`,
      body: `Messages sent then got an answer ${pct(a)} of the time, against ${pct(b)} at other times.`,
      magnitude: a - b,
      impact: (a - b) * restN * 0.1,
    };
    if (!best || found.magnitude > best.magnitude) best = found;
  }
  return best;
};

const followupsSlip: Detector = ({ followups: f, view }) => {
  if (!f || f.nowDone < 50 || f.beforeDone < 50 || f.overdue < 10) return null;
  const now = f.nowOnTime / f.nowDone;
  const before = f.beforeOnTime / f.beforeDone;
  if (before - now < 0.08 || !real(f.beforeOnTime, f.beforeDone, f.nowOnTime, f.nowDone)) return null;
  const top = [...f.overdueBy].sort((a, b) => b.n - a.n);
  const most = view === "team" && top.length && top.slice(0, 2).reduce((a, x) => a + x.n, 0) > f.overdue / 2;
  return {
    id: "followups_slip",
    subject: "all",
    title: "Follow-ups are slipping",
    body: `On time fell from ${pct(before)} to ${pct(now)}. ${f.overdue} are overdue now${most ? `, most of them ${possessives(top.slice(0, 2).map((x) => x.name))}` : ""}.`,
    magnitude: before - now,
    impact: (before - now) * f.nowDone,
  };
};

const repSupport: Detector = ({ people, view }) => {
  if (view !== "team" || !people?.length) return null;
  const done = people.reduce((a, p) => a + p.done, 0);
  const onTime = people.reduce((a, p) => a + p.onTime, 0);
  if (done < 100) return null;
  const out: Insight[] = [];
  for (const p of people) {
    if (p.done < 30) continue;
    const restN = done - p.done;
    const restOn = onTime - p.onTime;
    const a = p.onTime / p.done;
    const b = restOn / restN;
    if (b - a < 0.1 || !real(p.onTime, p.done, restOn, restN)) continue;
    out.push({
      id: "rep_support",
      subject: p.id,
      title: `${p.name} may need a hand with follow-ups`,
      body: `${p.name}’s are on time ${pct(a)} of the time, against ${pct(b)} for the team.`,
      magnitude: b - a,
      impact: (b - a) * p.done,
    });
  }
  return out;
};

const weekdayLate: Detector = ({ people, view }) => {
  if (!people?.length) return null;
  const out: Insight[] = [];
  for (const p of people) {
    const late = p.lateByWeekday.reduce((a, b) => a + b, 0);
    if (late < 8) continue;
    const peak = Math.max(...p.lateByWeekday);
    const day = p.lateByWeekday.indexOf(peak);
    if (peak / late < 0.6) continue;
    const own = view === "own";
    out.push({
      id: "weekday_late",
      subject: p.id,
      title: own ? `Your follow-ups slip on ${DAYS[day]}s` : `${p.name}’s follow-ups slip on ${DAYS[day]}s`,
      body: own
        ? `${peak} of your ${late} late follow-ups were due on a ${DAYS[day]}.`
        : `${peak} of ${p.name}’s ${late} late follow-ups were due on a ${DAYS[day]}.`,
      magnitude: peak / late,
      impact: peak * 0.5,
    });
  }
  return out;
};

const stageDrop: Detector = ({ stages }) => {
  if (!stages?.length) return null;
  const eligible = stages.filter((s) => s.reached >= 50);
  if (!eligible.length) return null;
  const worst = eligible.reduce((a, s) => (s.stopped / s.reached > a.stopped / a.reached ? s : a));
  const now = worst.stopped / worst.reached;
  if (!worst.prevReached) return null;
  const before = worst.prevStopped / worst.prevReached;
  if (now <= before || !real(worst.stopped, worst.reached, worst.prevStopped, worst.prevReached)) return null;
  return {
    id: "stage_drop",
    subject: worst.id,
    title: `Most leads stop at ${worst.name}`,
    body: `${pct(now)} of leads that reached ${worst.name} went no further.`,
    magnitude: now,
    impact: (now - before) * worst.reached,
  };
};

const lostReasonUp: Detector = ({ lostReasons }) => {
  if (!lostReasons?.length) return null;
  const now = lostReasons.reduce((a, r) => a + r.now, 0);
  const before = lostReasons.reduce((a, r) => a + r.before, 0);
  if (now < 20 || before < 20) return null;
  let best: Insight | null = null;
  for (const r of lostReasons) {
    const a = r.now / now;
    const b = r.before / before;
    if (a - b < 0.1 || !real(r.now, now, r.before, before)) continue;
    const found: Insight = {
      id: "lost_reason_up",
      subject: r.id,
      title: `“${r.name}” is rising`,
      body: `It’s behind ${pct(a)} of leads lost, up from ${pct(b)}.`,
      magnitude: a - b,
      impact: (a - b) * now,
    };
    if (!best || found.magnitude > best.magnitude) best = found;
  }
  return best;
};

const templateBest: Detector = ({ templates }) => {
  if (!templates?.length) return null;
  const sends = templates.reduce((a, t) => a + t.sends, 0);
  const replies = templates.reduce((a, t) => a + t.replies, 0);
  let best: Insight | null = null;
  for (const t of templates) {
    if (t.sends < 50 || sends - t.sends < 150) continue;
    const a = t.replies / t.sends;
    const b = (replies - t.replies) / (sends - t.sends);
    if (a - b < 0.1 || !real(t.replies, t.sends, replies - t.replies, sends - t.sends)) continue;
    const found: Insight = {
      id: "template_best",
      subject: t.id,
      title: `“${t.name}” gets the most replies`,
      body: `${pct(a)} of its messages got an answer, against ${pct(b)} for your other messages.`,
      magnitude: a - b,
      impact: (a - b) * (sends - t.sends) * 0.1,
    };
    if (!best || found.magnitude > best.magnitude) best = found;
  }
  return best;
};

const wonBack: Detector = ({ wonBack: w, money }) => {
  if (!w || w.n < 3) return null;
  const worth = money(w.value);
  return {
    id: "won_back",
    subject: "all",
    title: `LUME helped win back ${w.n} lost leads`,
    body: worth ? `Worth ${worth}, from leads once marked lost.` : "Leads once marked lost, won after all.",
    magnitude: w.n,
    impact: w.n,
  };
};

const eveningArrivals: Detector = ({ arrivals: a }) => {
  if (!a || a.total < 200 || a.afterHours / a.total < 0.3) return null;
  return {
    id: "evening_arrivals",
    subject: "all",
    title: `${pct(a.afterHours / a.total)} of leads arrive after hours`,
    body:
      `They come in after ${a.after}.` +
      (a.evidence && a.contactBefore
        ? ` Contacting them before ${a.contactBefore} the next morning wins more of them.`
        : ""),
    magnitude: a.afterHours / a.total,
    impact: a.afterHours * 0.02,
  };
};

const goalPace: Detector = ({ goal: g }) => {
  if (!g || g.elapsed < 0.2 || g.target <= 0) return null;
  const pace = g.value / g.elapsed / g.target;
  return {
    id: "goal_pace",
    subject: `${g.metricWords}:${g.month}`,
    title: `At this pace, ${g.month} ends at ${pct(pace)} of the ${g.metricWords} goal`,
    body: `${g.shown(g.value)} so far, with ${g.daysLeft} ${g.daysLeft === 1 ? "day" : "days"} to go.`,
    magnitude: pace,
    impact: Math.abs(1 - pace) * 5,
  };
};

const slotNoShow: Detector = ({ slots }) => {
  if (!slots?.length) return null;
  const booked = slots.reduce((a, s) => a + s.booked, 0);
  const missed = slots.reduce((a, s) => a + s.noShow, 0);
  let best: Insight | null = null;
  for (const s of slots) {
    if (s.booked < 20 || booked - s.booked < 80) continue;
    const a = s.noShow / s.booked;
    const b = (missed - s.noShow) / (booked - s.booked);
    if (a - b < 0.1 || !real(s.noShow, s.booked, missed - s.noShow, booked - s.booked)) continue;
    const found: Insight = {
      id: "slot_noshow",
      subject: `${s.day}:${s.hour}`,
      title: `Calls on ${DAYS[s.day]} ${windowWords(s)} are missed more often`,
      body: `${pct(a)} of them were no-shows, against ${pct(b)} at other times.`,
      magnitude: a - b,
      impact: (a - b) * s.booked,
    };
    if (!best || found.magnitude > best.magnitude) best = found;
  }
  return best;
};

export const DETECTORS: Record<DetectorId, Detector> = {
  speed_pays: speedPays,
  source_over: sourceOver,
  source_under: sourceUnder,
  reply_window: replyWindow,
  followups_slip: followupsSlip,
  rep_support: repSupport,
  weekday_late: weekdayLate,
  stage_drop: stageDrop,
  lost_reason_up: lostReasonUp,
  template_best: templateBest,
  won_back: wonBack,
  evening_arrivals: eveningArrivals,
  goal_pace: goalPace,
  slot_noshow: slotNoShow,
};

/** Seen before (the cooldown, spec §6.4): shown to this person in the last 14 days, at a magnitude within half. */
export type Seen = { detector: DetectorId; subject: string; magnitude: number; shownAt: Date };
export const COOLDOWN_DAYS = 14;

export function cooling(i: Insight, seen: Seen[], now: Date): boolean {
  const s = seen.find((x) => x.detector === i.id && x.subject === i.subject);
  if (!s) return false;
  if (now.getTime() - s.shownAt.getTime() >= COOLDOWN_DAYS * 86_400_000) return false;
  const moved =
    s.magnitude === 0
      ? i.magnitude !== 0
      : Math.abs(i.magnitude - s.magnitude) / Math.abs(s.magnitude) >= 0.5;
  return !moved;
}

/** Every detector run; the top three by impact, never two from one detector, minus those cooling down. */
export function noticed(c: InsightContext, seen: Seen[] = [], now = new Date()): Insight[] {
  const all = (Object.values(DETECTORS) as Detector[]).flatMap((d) => {
    const r = d(c);
    return r === null ? [] : Array.isArray(r) ? r : [r];
  });
  const picked: Insight[] = [];
  for (const i of all.filter((x) => !cooling(x, seen, now)).sort((a, b) => b.impact - a.impact)) {
    if (picked.some((p) => p.id === i.id)) continue;
    picked.push(i);
    if (picked.length === 3) break;
  }
  return picked;
}

/** Before any detector can speak (spec §6.3). */
export const NOT_YET = {
  title: "LUME needs a little more to go on",
  body: "Suggestions start once there are about 200 leads and a month of follow-ups.",
  progress: (n: number) => `${Math.min(n, 200).toLocaleString("en-US")} of 200 leads`,
};
