"use client";
import { api } from "@/lib/api";

export type RoleRef = { id: string; name: string };
export type UserRow = {
  id: string;
  name: string;
  email: string;
  status: "invited" | "active" | "disabled" | "suspended";
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
  /** What offboarding someone would do (6C): counts only, never a contact. */
  offboarding: (id: string) => api.get<OffboardPreview>(`/api/v1/users/${id}/offboarding`),
  offboard: (id: string, leads: LeadsChoice) =>
    api.post<OffboardOutcome>(`/api/v1/users/${id}/offboard`, { leads }),
};

export type TeamMember = { id: string; name: string; openLeads: number };
export type OffboardPreview = {
  person: { id: string; name: string; status: UserRow["status"] };
  sessions: number;
  leads: { total: number; open: number };
  /** The person's teams first; active members only, never the person. */
  teams: { id: string; name: string; members: TeamMember[] }[];
  people: { id: string; name: string }[];
  calendar: { email: string; upcoming: number } | null;
  last30: {
    reveals: number;
    leadsOpened: number;
    exports: number;
    alerts: number;
    /** A day on the business's clock, YYYY-MM-DD. */
    busiest: { day: string; count: number } | null;
    usualPerDay: number;
  };
};
export type LeadsChoice = { to: "person"; userId: string } | { to: "team"; teamId: string } | { to: "none" };
export type OffboardOutcome = {
  sessions: number;
  leads: { to: LeadsChoice["to"]; moved: number; shares?: { id: string; name: string; count: number }[] };
  calendar: { meetingsMoved: number; meetingsRemoved: number } | null;
};
