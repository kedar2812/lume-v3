import type { LicenceType } from "@lume/core/shared";
import { formatMoney, type Price } from "./money";
import { daysBetween, utcDay } from "./state";

/** What the bell looks at, per client. */
export type AlertClient = {
  id: string;
  name: string;
  type: LicenceType;
  paidUntil: string | null;
  trialEnds: string | null;
  suspended: boolean;
  decommissioned: boolean;
  lastCheckInAt: string | null;
  version: string | null;
  price: Price | null;
  monthlyInr: number | null;
};
export type Alert = {
  /** Stable per condition ("late:<client>"): a hidden alert stays hidden while its fingerprint holds. */
  id: string;
  fingerprint: string;
  tone: "red" | "amber" | "blue" | "violet" | "grey";
  title: string;
  body: string;
  clientId: string | null;
  clientName: string | null;
};

const DAY = 86_400_000;
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "26 Sep" */
export const shortDay = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
const hours = (ms: number) =>
  ms >= 2 * DAY ? `${Math.floor(ms / DAY)}\u00a0days` : `${Math.floor(ms / 3_600_000)}\u00a0h`;
const andList = (xs: string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? "");

/** Numeric version order: 1.10.0 is newer than 1.9.3. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The bell, "Needs a look" (spec §4.4), most urgent first: payments late; no check-in for over 24 hours;
 * payments due within 5 days; trials ending within 15; installations on an older version (one, grouped).
 * Suspended and decommissioned clients need nothing.
 */
export function alertsFor(clients: AlertClient[], o: { now: Date; latestVersion: string | null }): Alert[] {
  const today = utcDay(o.now);
  const live = clients.filter((c) => !c.suspended && !c.decommissioned);
  const late: Alert[] = [];
  const quiet: Alert[] = [];
  const due: Alert[] = [];
  const trial: Alert[] = [];
  const owed = (c: AlertClient) =>
    c.price && c.price.periodMonths ? formatMoney(c.price.amount, c.price.currency) : null;
  for (const c of live) {
    if (c.type === "subscription" && c.paidUntil) {
      const behind = daysBetween(c.paidUntil, today);
      const amount = owed(c);
      if (behind > 0)
        late.push({
          id: `late:${c.id}`,
          fingerprint: c.paidUntil,
          tone: "red",
          title: `${c.name}'s payment is ${days(behind)} late`,
          body: `${amount ? `${amount} was` : "It was"} due on ${shortDay(c.paidUntil)}. Send a reminder and they see it at every sign-in until it's paid.`,
          clientId: c.id,
          clientName: c.name,
        });
      else if (-behind <= 5)
        due.push({
          id: `due:${c.id}`,
          fingerprint: c.paidUntil,
          tone: "blue",
          title: behind === 0 ? `${c.name} pays today` : `${c.name} pays in ${days(-behind)}`,
          body: `${amount ? `${amount}, due` : "Due"} ${shortDay(c.paidUntil)}. Mark it paid when it arrives.`,
          clientId: c.id,
          clientName: c.name,
        });
    }
    if (c.lastCheckInAt) {
      const silent = o.now.getTime() - Date.parse(c.lastCheckInAt);
      if (silent > DAY)
        quiet.push({
          id: `quiet:${c.id}`,
          fingerprint: c.lastCheckInAt,
          tone: "amber",
          title: `${c.name} hasn't checked in for ${hours(silent)}`,
          body: "Its server may be off or offline. It keeps working for 7 days.",
          clientId: c.id,
          clientName: c.name,
        });
    }
    if (c.type === "trial" && c.trialEnds) {
      const left = daysBetween(today, c.trialEnds);
      if (left >= 0 && left <= 15)
        trial.push({
          id: `trial:${c.id}`,
          fingerprint: c.trialEnds,
          tone: "violet",
          title: left === 0 ? `${c.name}'s trial ends today` : `${c.name}'s trial ends in ${days(left)}`,
          body: "A good week for a friendly call about staying on.",
          clientId: c.id,
          clientName: c.name,
        });
    }
  }
  const alerts = [...late, ...quiet, ...due, ...trial];
  const latest = o.latestVersion;
  if (latest) {
    const behind = live.filter((c) => c.version && compareVersions(c.version, latest) < 0);
    if (behind.length) {
      const versions = [...new Set(behind.map((c) => c.version!))];
      alerts.push({
        id: "old",
        fingerprint: `${latest}|${behind
          .map((c) => c.id)
          .sort()
          .join(",")}`,
        tone: "grey",
        title:
          versions.length === 1
            ? `${behind.length} ${behind.length === 1 ? "installation is" : "installations are"} on an older version`
            : `${behind.length} installations are on older versions`,
        body: `${andList(behind.map((c) => c.name))}. ${latest} is out.`,
        clientId: behind.length === 1 ? behind[0]!.id : null,
        clientName: behind.length === 1 ? behind[0]!.name : null,
      });
    }
  }
  return alerts;
}

/** Hidden alerts stay hidden only while their condition is the same one that was hidden. */
export function visibleAlerts(alerts: Alert[], hidden: ReadonlyMap<string, string>): Alert[] {
  return alerts.filter((a) => hidden.get(a.id) !== a.fingerprint);
}
