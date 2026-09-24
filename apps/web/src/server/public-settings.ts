import { cache } from "react";
import { apiGet } from "./api";

/**
 * The business name for signed-out screens. GET /settings needs a session, so a stranger simply sees
 * "LUME" — never an error, and never the client's name.
 */
export const publicBusinessName = cache(async (): Promise<string> => {
  const { status, data } = await apiGet<{ businessName: string }>("/api/v1/settings");
  return status === 200 && data?.businessName ? data.businessName : "LUME";
});
