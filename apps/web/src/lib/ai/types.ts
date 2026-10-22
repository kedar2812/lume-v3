import type { NextStep } from "@lume/core/shared";

/** LUME AI as the API says it (spec 2026-10-18 §2.2, plan Task 5). */
export type AiLimit = { used: number; limit: number | null; resetsAt: string };
export type AiPause = { by: "hour" | "week" | "month"; until: string };
/**
 * Autopilot A1 (spec 2026-10-19 §4): the month beside the hour and the week; the spend at the owner's prices (null when
 * none are set); the pace; and, for admins, whether a top-up has been asked for this month.
 */
export type AiStatus = {
  on: boolean;
  hour: AiLimit;
  week: AiLimit;
  month: AiLimit;
  paused: AiPause | null;
  spend: { used: number; cap: number | null; currency: "USD" } | null;
  pace: { daysLeft: number | null };
  topUp: { asked: boolean } | null;
};
/** Why no suggestion came back: off, not set up here, at a limit (and until when), or the read failed. */
export type AiUnavailable =
  | { unavailable: "off" | "not_configured" | "failed" }
  | { unavailable: "limit"; by: AiPause["by"]; until: string };
export type Part = "stage" | "followUp" | "tags";
/** `dueAt`: the suggested follow-up as a moment, read on the person's own clock (null when there's none). */
export type NextStepRead = { read: { id: string; suggestion: NextStep; dueAt: string | null } };
export type Applied = { applied: Part[]; skipped: { part: Part; why: string }[] };
export type LeadAi = {
  offerCatchUp: boolean;
  pending: {
    id: string;
    suggestion: NextStep;
    dueAt: string | null;
    from: { activityId: string | null; at: string };
  } | null;
};
export type CatchUpRead = { read: { id: string; lines: [string, string, string] } };
