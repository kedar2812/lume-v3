"use client";
import { api } from "@/lib/api";

export type MySession = {
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
};

/** The signed-in person's own account: profile, two-step sign-in, recovery codes and sessions. */
export const accountClient = {
  sessions: () => api.get<{ sessions: MySession[] }>("/api/v1/me/sessions"),
  endSession: (id: string) => api.del<null>(`/api/v1/me/sessions/${id}`),
  updateProfile: (patch: { name?: string; timezone?: string }) => api.patch<null>("/api/v1/me", patch),
  beginTwoFactor: () => api.post<{ secret: string; otpauthUri: string }>("/api/v1/me/2fa/enrol"),
  confirmTwoFactor: (code: string) =>
    api.post<{ recoveryCodes: string[] }>("/api/v1/me/2fa/confirm", { code }),
  disableTwoFactor: (password: string) => api.post<null>("/api/v1/me/2fa/disable", { password }),
  newRecoveryCodes: (password: string) =>
    api.post<{ recoveryCodes: string[] }>("/api/v1/me/recovery-codes", { password }),
};
