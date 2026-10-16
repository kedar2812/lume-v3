import type { FeedbackReport } from "@lume/core/shared";
import { api } from "@/lib/api";

/** Send feedback (spec 2026-10-16 §1.4): straight through this LUME's API to LUME's team. */
export const feedbackClient = {
  send: (report: FeedbackReport) => api.post<{ ok: true }>("/api/v1/feedback", report),
};
