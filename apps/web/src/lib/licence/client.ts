"use client";
import type { LicenceView } from "@lume/core/shared";
import { api } from "@/lib/api";

/** The licence as one person sees it (licensing L-A): what the API sends with /auth/me and on its own. */
export type LicenceForPerson = LicenceView & {
  instanceId: string | null;
  nextCheckAt: string | null;
  /** Show the payment reminder now (owners and admins; not closed this session). */
  showNotice: boolean;
  /** May Check now (people who manage settings). */
  canCheck: boolean;
  /** Why the last check brought no new answer (people who manage settings only), or null. */
  lastError: string | null;
};

/** Said on window when the API refuses for the licence (403 LICENSE_*): the shell looks at it again. */
export const LICENCE_REFUSED = "lume:licence-refused";

export const licenceClient = {
  get: () => api.get<LicenceForPerson>("/api/v1/licence"),
  check: () => api.post<LicenceForPerson>("/api/v1/licence/check"),
  dismiss: () => api.post<null>("/api/v1/licence/notice/dismiss"),
};

/** Where Export all data downloads from (a zip, in every licence state). */
export const EXPORT_URL = "/api/v1/export";
