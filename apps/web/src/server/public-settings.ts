import { cache } from "react";
import { apiGet } from "./api";

/** True only on a brand-new installation that has no owner yet. */
export const needsSetup = cache(async (): Promise<boolean> => {
  const { status, data } = await apiGet<{ needsSetup: boolean }>("/api/v1/setup/status");
  return status === 200 && data?.needsSetup === true;
});

/**
 * The business name for signed-out screens. GET /settings needs a session, so a stranger gets "" and the
 * screen shows only the LUME wordmark — never an error, and never the client's name.
 */
export const publicBusinessName = cache(async (): Promise<string> => {
  const { status, data } = await apiGet<{ businessName: string }>("/api/v1/settings");
  return status === 200 && data?.businessName ? data.businessName : "";
});
