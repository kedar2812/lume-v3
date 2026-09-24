"use client";
import { api } from "./api";

/** The first-run setup call (1A: `POST /api/v1/setup`), typed exactly as the API's body schema. */
export type SetupInput = {
  token: string;
  business: { name: string; timezone: string; currency: string; defaultCountry: string };
  preset: "coaching" | "general";
  owner: { name: string; email: string; password: string };
  totp: { secret: string; code: string };
};
export type SetupResult =
  | { status: "ok"; recoveryCodes: string[] }
  | { status: "token" }
  | { status: "code" }
  | { status: "weak"; problems: string[] }
  | { status: "unavailable" };

export async function startTotp(
  token: string,
): Promise<{ secret: string; otpauthUri: string } | { error: string }> {
  const r = await api.post<{ secret: string; otpauthUri: string }>("/api/v1/setup/totp", { token });
  if (r.ok) return r.data;
  return {
    error:
      r.code === "SETUP_TOKEN" ? "That setup token isn’t valid. Copy it from the server logs." : r.message,
  };
}

export async function completeSetup(input: SetupInput): Promise<SetupResult> {
  const r = await api.post<{ recoveryCodes: string[] }>("/api/v1/setup", input);
  if (r.ok) return { status: "ok", recoveryCodes: r.data.recoveryCodes };
  if (r.code === "SETUP_TOKEN") return { status: "token" };
  if (r.code === "INVALID_CODE") return { status: "code" };
  if (r.code === "WEAK_PASSWORD")
    return { status: "weak", problems: (r.details as { problems?: string[] } | undefined)?.problems ?? [] };
  return { status: "unavailable" };
}
