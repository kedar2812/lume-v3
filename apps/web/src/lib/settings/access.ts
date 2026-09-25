import type { ApiResult } from "@/lib/api";

/**
 * Whether a refusal means this person's access was taken away mid-visit (the plain "no permission"
 * 403), as opposed to a 403 with its own reason, like handing out more access than you hold, which the
 * page should explain and stay on.
 */
export const accessGone = <T>(r: ApiResult<T>): boolean =>
  !r.ok && r.status === 403 && r.code === "FORBIDDEN";
