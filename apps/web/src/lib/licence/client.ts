"use client";
import type { AnnouncementClaim, LicenceView, PlanClaim } from "@lume/core/shared";
import { api } from "@/lib/api";

/** The licence as one person sees it (licensing L-A): what the API sends with /auth/me and on its own. */
/** An announcement from LUME's team as one person sees it (spec 2026-10-16 fleet §4). */
export type AnnouncementForPerson = AnnouncementClaim & { gotIt: boolean };

/** The plan as one person sees it (spec 2026-10-17 control §2): people who manage settings only, else null. */
export type PlanForPerson = PlanClaim & { taken: number };

export type LicenceForPerson = Omit<LicenceView, "announcements" | "plan"> & {
  /** The plan with places taken now (people who manage settings), or null: no limits, or not theirs to see. */
  plan: PlanForPerson | null;
  /** From LUME's team: the ones meant for this person, not ended (absent from an older API: normalised to []). */
  announcements: AnnouncementForPerson[];
  instanceId: string | null;
  nextCheckAt: string | null;
  /** Show the payment reminder now (owners and admins; not closed this session). */
  showNotice: boolean;
  /** May Check now (people who manage settings). */
  canCheck: boolean;
  /** Why the last check brought no new answer (people who manage settings only), or null. */
  lastError: string | null;
  /** The product key (spec 2026-10-15 §1.3): its last four, where it's set, and whether this person may change it. */
  key: { masked: string | null; source: "env" | "stored" | null; canChange: boolean };
  /** Send feedback shows (spec 2026-10-16 §1.1): there is a key to send it under. */
  feedback: boolean;
};

/** Said on window when the API refuses for the licence (403 LICENSE_*): the shell looks at it again. */
export const LICENCE_REFUSED = "lume:licence-refused";

export const licenceClient = {
  get: () => api.get<LicenceForPerson>("/api/v1/licence"),
  check: () => api.post<LicenceForPerson>("/api/v1/licence/check"),
  dismiss: () => api.post<null>("/api/v1/licence/notice/dismiss"),
  /** The owner's Change key (Settings → About): approved, the licence as it now is. */
  changeKey: (key: string) => api.post<LicenceForPerson>("/api/v1/licence/key", { key }),
  /** Got it on an announcement (fleet §4): once per person, on every device. */
  gotIt: (id: string) =>
    api.post<LicenceForPerson>(`/api/v1/licence/announcements/${encodeURIComponent(id)}/got-it`),
};

/** Where Export all data downloads from (a zip, in every licence state). */
export const EXPORT_URL = "/api/v1/export";
