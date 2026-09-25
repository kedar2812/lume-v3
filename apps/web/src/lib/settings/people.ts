"use client";
import { api } from "@/lib/api";

export type RoleRef = { id: string; name: string };
export type UserRow = {
  id: string;
  name: string;
  email: string;
  status: "invited" | "active" | "disabled";
  isOwner: boolean;
  twoFactor: boolean;
  lastLoginAt: string | null;
  roles: RoleRef[];
};
export type Invite = {
  id: string;
  email: string;
  name: string;
  roles: RoleRef[];
  invitedBy: string | null;
  expiresAt: string;
  expired: boolean;
};
type Sent = { invite: { id: string; email: string; expiresAt: string }; url: string };

/** Invites: send, resend (a fresh link; the old one stops working) and revoke. */
export const invitesClient = {
  create: (input: { email: string; name: string; roleIds: string[] }) =>
    api.post<Sent>("/api/v1/invites", input),
  resend: (id: string) => api.post<null>(`/api/v1/invites/${id}/resend`),
  revoke: (id: string) => api.del<null>(`/api/v1/invites/${id}`),
};

/** The people already in LUME: their role, access, and sessions. */
export const usersClient = {
  setRoles: (id: string, roleIds: string[]) => api.patch<null>(`/api/v1/users/${id}`, { roleIds }),
  disable: (id: string, input: { reassignTo: string | null }) =>
    api.post<null>(`/api/v1/users/${id}/disable`, input),
  enable: (id: string) => api.post<null>(`/api/v1/users/${id}/enable`),
  endSessions: (id: string) => api.del<null>(`/api/v1/users/${id}/sessions`),
};
