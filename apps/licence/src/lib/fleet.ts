import type { FleetHealth } from "@lume/core/shared";

/**
 * Fleet (spec 2026-10-16 fleet §2.2): how each client's LUME is, from what it said at its newest check-in, and the
 * words for each problem — what's wrong and what to do on their server.
 */
export type FleetStatus = "down" | "look" | "none" | "ok";
export type Problem = { key: string; severity: "red" | "amber"; short: string; words: string };

const H = 3_600_000;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function problemsOf(h: FleetHealth | null, now: Date): Problem[] {
  if (!h) return [];
  const out: Problem[] = [];
  const add = (key: string, severity: Problem["severity"], short: string, words: string) => {
    if (!out.some((p) => p.key === key)) out.push({ key, severity, short, words });
  };
  const has = (k: FleetHealth["problems"][number]) => h.problems.includes(k);

  if (h.diskFreePct !== null && h.diskFreePct < 5)
    add(
      "disk",
      "red",
      "Disk almost full",
      `The server’s disk is almost full: ${h.diskFreePct}% free. When it fills, LUME stops saving. Free space on their server, or give it a bigger disk.`,
    );
  else if (h.diskFreePct !== null && h.diskFreePct < 15)
    add("disk", "amber", "Disk filling", `The server’s disk is filling: ${h.diskFreePct}% free. Free space before it runs out.`);
  if (has("reminders_late"))
    add(
      "reminders_late",
      "amber",
      "Reminders late",
      "Follow-up reminders are late: the engine may have stopped. Restart LUME’s API on their server.",
    );
  if (has("sweeper_stopped"))
    add(
      "sweeper_stopped",
      "amber",
      "Reminders stopped",
      "Follow-up reminders haven’t been checked for over 5 minutes. Restart LUME’s API on their server.",
    );
  if (has("jobs_unreadable"))
    add(
      "jobs_unreadable",
      "amber",
      "Jobs unreadable",
      "LUME couldn’t read its background jobs. If this stays, restart LUME’s API on their server.",
    );
  if (has("jobs_failed") || h.queue.failed24h > 0) {
    const n = Math.max(1, h.queue.failed24h);
    add(
      "jobs_failed",
      "amber",
      "Jobs failing",
      `${plural(n, "background job", "background jobs")} failed in the last day, after 5 tries each. Look at the worker’s log on their server.`,
    );
  }
  if (has("digest_failing"))
    add(
      "digest_failing",
      "amber",
      "Emails failing",
      "Morning emails aren’t going out. Check the mail server settings (SMTP_URL in their .env).",
    );
  if (has("source")) {
    const n = Math.max(1, h.sourcesNeedingAttention);
    add(
      "source",
      "amber",
      "Source needs attention",
      `${plural(n, "lead source needs", "lead sources need")} attention. Their admin can see which in Integrations.`,
    );
  }
  const t = h.restoreTest;
  if (t && !t.ok)
    add("restore_test", "amber", "Restore test failed", "The last backup restore test failed. Check the backups on their server.");
  else if (has("restore_test") || (t && now.getTime() - Date.parse(t.at) > 8 * 24 * H))
    add(
      "restore_test",
      "amber",
      "Restore test old",
      "No backup restore test in over 8 days. Check the worker on their server.",
    );
  if (h.errors24h >= 20)
    add("errors", "amber", "Errors", `${h.errors24h} errors in the last 24 hours. Look at the API’s log on their server.`);

  return [...out.filter((p) => p.severity === "red"), ...out.filter((p) => p.severity === "amber")];
}

/** Down, needs a look, no health yet (an older LUME), or healthy; null for a LUME that never checked in. */
export function fleetStatus(
  o: { lastCheckInAt: string | null; health: FleetHealth | null },
  now: Date,
): FleetStatus | null {
  if (!o.lastCheckInAt) return null;
  if (now.getTime() - Date.parse(o.lastCheckInAt) > 24 * H) return "down";
  if (!o.health) return "none";
  return problemsOf(o.health, now).length ? "look" : "ok";
}

/** Worst first. */
export const STATUS_RANK: Record<FleetStatus, number> = { down: 0, look: 1, none: 2, ok: 3 };

/** "412 MB", "1.9 GB" — a database's size as people say it. */
export function bytesText(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}
/** "12 days", "5 h", "40 min" — how long LUME's API has been up. */
export function uptimeText(s: number | null): string {
  if (s === null) return "—";
  if (s >= 2 * 86_400) return `${Math.floor(s / 86_400)} days`;
  if (s >= 3_600) return `${Math.floor(s / 3_600)} h`;
  return `${Math.max(1, Math.floor(s / 60))} min`;
}
export const STATUS_WORDS: Record<FleetStatus, string> = {
  down: "Down",
  look: "Needs a look",
  none: "No health yet",
  ok: "Healthy",
};
