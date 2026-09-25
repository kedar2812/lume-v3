"use client";
import { api } from "@/lib/api";

export type TeamMember = { userId: string; isLead: boolean };
export type Team = { id: string; name: string; members: TeamMember[] };

/** Teams: who works together, and who leads them (a lead sees the team's leads when a role allows it). */
export const teamsClient = {
  create: (name: string) => api.post<{ team: Team }>("/api/v1/teams", { name }),
  rename: (id: string, name: string) => api.patch<null>(`/api/v1/teams/${id}`, { name }),
  remove: (id: string) => api.del<null>(`/api/v1/teams/${id}`),
  setMembers: (id: string, members: TeamMember[]) =>
    api.put<{ team: Team }>(`/api/v1/teams/${id}/members`, { members }),
};
