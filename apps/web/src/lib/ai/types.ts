import type { NextStep } from "@lume/core/shared";

/** LUME AI as the API says it (spec 2026-10-18 §2.2, plan Task 5). */
export type AiLimit = { used: number; limit: number | null; resetsAt: string };
export type AiPause = { by: "hour" | "week"; until: string };
export type AiStatus = { on: boolean; hour: AiLimit; week: AiLimit; paused: AiPause | null };
/** Why no suggestion came back: off, not set up here, at a limit (and until when), or the read failed. */
export type AiUnavailable =
  | { unavailable: "off" | "not_configured" | "failed" }
  | { unavailable: "limit"; by: AiPause["by"]; until: string };
export type Part = "stage" | "followUp" | "tags";
export type NextStepRead = { read: { id: string; suggestion: NextStep } };
export type Applied = { applied: Part[]; skipped: { part: Part; why: string }[] };
export type LeadAi = {
  offerCatchUp: boolean;
  pending: { id: string; suggestion: NextStep; from: { activityId: string | null; at: string } } | null;
};
export type CatchUpRead = { read: { id: string; lines: [string, string, string] } };
