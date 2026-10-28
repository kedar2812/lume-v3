import { AUTOPILOT_ACTION_TITLES, type LeadState } from "@lume/core/shared";
import { nearDay, timeOf } from "@/lib/dates";
import type { RunAsk, RunDetail, RunLead } from "./types";

/** The states LUME AI is still working (core's ACTIVE_STATES, as the screen reads them). */
const WORKING: readonly LeadState[] = ["up_next", "writing", "sent", "replied", "talking"];
/** A message is being written, or one is about to be. */
const BUSY: readonly LeadState[] = ["up_next", "writing", "replied"];

const PAUSED: Record<string, { title: string; line: string }> = {
  person: { title: "Paused", line: "Nothing is sent until you resume." },
  month: {
    title: "Paused: this month's LUME AI is used",
    line: "It carries on by itself once a top-up is added.",
  },
  quality: {
    title: "Paused to protect your WhatsApp number",
    line: "WhatsApp lowered your number's rating. Resume once it recovers.",
  },
  speaker: {
    title: "Paused: the person it speaks as can't send messages now",
    line: "Resume once they can, or start a new run speaking as someone else.",
  },
  number: {
    title: "Paused: the WhatsApp number isn't connected",
    line: "Connect it again in Settings → Integrations → WhatsApp, then resume.",
  },
  paid: {
    title: "Paused: this month's paid WhatsApp messages are used",
    line: "Resume once more are added to your plan.",
  },
};

const n = (x: number) => x.toLocaleString("en-US");

/** Messaged, replied, ready for you and stopped, from what really happened to each lead (spec §2's counts). */
export function runCounts(d: RunDetail) {
  const inRun = d.leads.filter((l) => l.state !== "skipped");
  const messaged = inRun.filter((l) => l.lastSentAt).length;
  return {
    messaged,
    replied: inRun.filter((l) => l.repliedAt).length,
    ready: inRun.filter((l) => l.state === "ready" || l.state === "needs_you").length,
    stopped: inRun.filter((l) => l.state === "stopped").length,
    inRun: inRun.length,
    done: inRun.length ? messaged / inRun.length : 0,
  };
}

/**
 * What the run bar says (spec §2; A3 Review Focus 5): working only while it's writing or has a message due now, and
 * every other state in words (when the next message goes, waiting for replies, waiting on you, each pause and why,
 * done), so the mark never draws forever over a run that's resting. `when` says a time on the business's clock.
 */
export function runStatus(
  d: RunDetail,
  now: Date,
  when: (iso: string) => string,
): { title: string; line: string | null; working: boolean } {
  const c = runCounts(d);
  if (d.run.status === "ended")
    return { title: "Done", line: `${n(c.messaged)} messaged · ${n(c.ready)} ready for you`, working: false };
  if (d.run.status === "paused")
    return { ...(PAUSED[d.run.pauseReason ?? "person"] ?? PAUSED.person!), working: false };
  const working = d.leads.filter((l) => WORKING.includes(l.state));
  const due = (l: RunLead) => !!l.nextAt && new Date(l.nextAt) <= now;
  const busy = working.filter((l) => BUSY.includes(l.state));
  // Writing, a message to write now, or a follow-up due now.
  if (working.some((l) => l.state === "writing" || due(l) || (BUSY.includes(l.state) && !l.nextAt)))
    return { title: "LUME AI is working", line: null, working: true };
  const soonest = (ls: RunLead[]) =>
    ls
      .map((l) => l.nextAt)
      .filter((x): x is string => !!x)
      .sort()[0];
  if (busy.length) {
    const next = soonest(busy);
    return {
      title: "Waiting to send the next message",
      line: next ? `Next one ${when(next)}` : null,
      working: false,
    };
  }
  if (working.length) {
    const next = soonest(working);
    return {
      title: "Waiting for replies",
      line: next ? `Next follow-up ${when(next)}` : "LUME AI follows up on the days you chose.",
      working: false,
    };
  }
  return { title: "Waiting on you", line: "The leads left are ready for you or with you.", working: false };
}

/** The lead LUME AI is on (§2: the blue rail): the one being written to, else the most recent it's working, else none. */
export function currentLead(d: RunDetail): RunLead | null {
  const writing = d.leads.find((l) => l.state === "writing");
  if (writing) return writing;
  const working = d.leads.filter((l) => WORKING.includes(l.state));
  if (!working.length) return null;
  return working.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
}

/** "at 10:00 am", "tomorrow at 10:00 am", "on October 28, Wednesday at 10:00 am": a time on the business's clock. */
export function whenWords(iso: string, tz: string, now: Date): string {
  const d = new Date(iso);
  const day = nearDay(d, tz, now);
  const t = timeOf(d, tz);
  if (day === "Today") return `at ${t}`;
  if (day === "Tomorrow") return `tomorrow at ${t}`;
  return `on ${day} at ${t}`;
}

/** A headline or reason without its closing full stop, to sit after a "·". */
const bare = (x: string) => x.replace(/[.\s]+$/, "");

/**
 * Each lead in the LUME AI page's list, in one line (plan 2026-10-28): what's happening with them, and a dot only where
 * it matters (LUME AI writing, a person needed, ready for one). The words carry the state too, never the colour alone.
 */
export function leadLine(
  l: RunLead,
  ask: RunAsk | null,
  when: (iso: string) => string,
): { text: string; dot: "writing" | "needs" | "ready" | null } {
  switch (l.state) {
    case "writing":
      return { text: l.draft?.kind === "template" ? "Writing a message" : "Writing a reply", dot: "writing" };
    case "needs_you": {
      const what = ask ? `${AUTOPILOT_ACTION_TITLES[ask.action]}?` : bare(l.card?.headline ?? l.reason ?? "");
      return { text: what ? `Needs you · ${what}` : "Needs you", dot: "needs" };
    }
    case "ready": {
      const what = bare(l.card?.headline ?? "");
      return { text: what ? `Ready · ${what}` : "Ready for you", dot: "ready" };
    }
    case "replied":
      return { text: l.repliedAt ? `Replied ${when(l.repliedAt)}` : "Replied", dot: null };
    case "sent":
      return { text: l.nextAt ? `Messaged · follow-up ${when(l.nextAt)}` : "Messaged", dot: null };
    case "up_next":
      return { text: l.nextAt ? `Up next ${when(l.nextAt)}` : "Up next", dot: null };
    case "talking":
      return { text: "Talking", dot: null };
    case "with_you":
      return { text: "With you", dot: null };
    case "stopped":
      return { text: "Stopped", dot: null };
    case "skipped":
      return { text: l.reason ?? "Skipped", dot: null };
  }
}

export type LeadFilter = "needs" | "ready" | "all";

/** The leads a filter shows, in the run's order; the skipped are never in the list (they fold away below it). */
export function leadsIn(leads: RunLead[], f: LeadFilter): RunLead[] {
  if (f === "needs") return leads.filter((l) => l.state === "needs_you");
  if (f === "ready") return leads.filter((l) => l.state === "ready");
  return leads.filter((l) => l.state !== "skipped");
}

/** The page opens on Needs you when someone needs you, else on everyone. */
export const defaultFilter = (leads: RunLead[]): LeadFilter =>
  leads.some((l) => l.state === "needs_you") ? "needs" : "all";

/**
 * The header's one line (plan 2026-10-28): going, who LUME AI is following up with and how far it's got, and when it
 * rests, what's next; paused and done in the run bar's own words.
 */
export function runLine(
  d: RunDetail,
  now: Date,
  when: (iso: string) => string,
): { text: string; working: boolean } {
  const st = runStatus(d, now, when);
  const c = runCounts(d);
  if (d.run.status === "paused")
    return { text: [st.title, st.line].filter(Boolean).join(" · "), working: false };
  if (d.run.status === "ended") return { text: `Done · ${st.line}`, working: false };
  const who = `${c.inRun === 1 ? "1 lead" : `${n(c.inRun)} leads`}`;
  const parts = [
    st.working ? `LUME AI is following up with ${who}` : `Following up with ${who}`,
    `${n(c.messaged)} messaged`,
    c.replied ? `${n(c.replied)} replied` : null,
    st.working ? null : (st.line ?? st.title),
  ];
  return { text: parts.filter(Boolean).join(" · "), working: st.working };
}
