"use client";
import type { AvatarColor } from "@lume/core/shared";
import { api } from "@/lib/api";
import type { Look } from "@/lib/avatar/look";

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
  /** Your look (7C): a colour for your initials (null = LUME's pick), a photo (base64 of the 256 px crop), or neither. */
  setAvatar: (patch: { color?: AvatarColor | null; image?: string | null }) =>
    api.put<{ avatar: Look }>("/api/v1/me/avatar", patch),
  removePhoto: () => api.del<{ avatar: Look }>("/api/v1/me/avatar"),
  beginTwoFactor: () => api.post<{ secret: string; otpauthUri: string }>("/api/v1/me/2fa/enrol"),
  confirmTwoFactor: (code: string) =>
    api.post<{ recoveryCodes: string[] }>("/api/v1/me/2fa/confirm", { code }),
  disableTwoFactor: (password: string) => api.post<null>("/api/v1/me/2fa/disable", { password }),
  newRecoveryCodes: (password: string) =>
    api.post<{ recoveryCodes: string[] }>("/api/v1/me/recovery-codes", { password }),
};
