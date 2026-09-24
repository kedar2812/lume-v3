"use client";
import { api, type ApiResult } from "./api";

export type SignInResult =
  | { status: "ok" }
  | { status: "otp_required" }
  | { status: "invalid" }
  | { status: "locked"; retryAfterSec?: number }
  | { status: "unavailable" };
export type AuthStep = "ok" | "invalid" | "locked" | "unavailable";

const retryAfter = (r: Extract<ApiResult<unknown>, { ok: false }>): number | undefined => {
  const d = r.details as { retryAfterSec?: number } | undefined;
  return typeof d?.retryAfterSec === "number" ? d.retryAfterSec : undefined;
};

export async function signIn(email: string, password: string): Promise<SignInResult> {
  const r = await api.post<{ next: "otp" | "done" }>("/api/v1/auth/login", { email, password });
  if (r.ok) return r.data.next === "otp" ? { status: "otp_required" } : { status: "ok" };
  if (r.status === 401) return { status: "invalid" };
  if (r.status === 429) {
    const secs = retryAfter(r);
    return secs === undefined ? { status: "locked" } : { status: "locked", retryAfterSec: secs };
  }
  return { status: "unavailable" };
}

const step = (r: ApiResult<unknown>): AuthStep =>
  r.ok
    ? "ok"
    : r.status === 429
      ? "locked"
      : r.status === 401 || r.status === 400
        ? "invalid"
        : "unavailable";

export const verifyOtp = async (code: string): Promise<AuthStep> =>
  step(await api.post("/api/v1/auth/2fa", { code }));
export const verifyRecoveryCode = async (code: string): Promise<AuthStep> =>
  step(await api.post("/api/v1/auth/recovery", { code }));

/** Always "sent": the API never reveals whether an address has an account (report §12.1). */
export async function requestPasswordReset(email: string): Promise<"sent" | "unavailable"> {
  const r = await api.post("/api/v1/auth/password/forgot", { email });
  return r.ok || r.status === 429 ? "sent" : "unavailable";
}

export type ResetResult =
  | { status: "ok" }
  | { status: "weak"; problems: string[] }
  | { status: "expired" }
  | { status: "unavailable" };

const problemsOf = (r: Extract<ApiResult<unknown>, { ok: false }>): string[] =>
  (r.details as { problems?: string[] } | undefined)?.problems ?? [];

export async function resetPassword(token: string, password: string): Promise<ResetResult> {
  const r = await api.post("/api/v1/auth/password/reset", { token, password });
  if (r.ok) return { status: "ok" };
  if (r.code === "WEAK_PASSWORD") return { status: "weak", problems: problemsOf(r) };
  if (r.code === "INVALID_TOKEN") return { status: "expired" };
  return { status: "unavailable" };
}

export type AcceptResult =
  { status: "ok" } | { status: "weak"; problems: string[] } | { status: "gone" } | { status: "unavailable" };

export async function acceptInvite(token: string, password: string): Promise<AcceptResult> {
  const r = await api.post(`/api/v1/invites/${token}/accept`, { password });
  if (r.ok) return { status: "ok" };
  if (r.code === "WEAK_PASSWORD") return { status: "weak", problems: problemsOf(r) };
  if (r.status === 404 || r.code === "USER_EXISTS") return { status: "gone" };
  return { status: "unavailable" };
}

/** The API's password problems, in words a person can act on. */
export const PASSWORD_PROBLEMS: Record<string, string> = {
  too_short: "Use at least 12 characters — a short sentence works well.",
  too_long: "That’s too long; keep it under 256 characters.",
  breached: "That password has appeared in a known data breach. Pick something else.",
  contains_email: "Don’t use your email address inside your password.",
};
export const passwordProblemText = (problems: string[]): string =>
  problems.length
    ? problems.map((p) => PASSWORD_PROBLEMS[p] ?? "Pick a stronger password.").join(" ")
    : "Pick a stronger password.";
