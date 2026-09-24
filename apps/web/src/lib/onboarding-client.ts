"use client";
import type { OnboardingStepId, PreferencesPatch } from "@lume/core/shared";
import { api } from "./api";
import { applyTheme, type ThemePref } from "./theme";

export type Person = { id: string; name: string; email: string; role: string; pending: boolean };
export type Stage = { id: string; name: string; kind: string; color: string };
export type Pipeline = { id: string; name: string; stages: Stage[] };

type UserRow = {
  id: string;
  name: string;
  email: string;
  status: string;
  isOwner: boolean;
  roles: { name: string }[];
};

/** Every server call the onboarding sheet makes, over the browser API client (CSRF + idempotency). */
export function onboardingActions() {
  return {
    async saveProfile(p: { name?: string; timezone?: string; theme?: ThemePref }) {
      const ok = (await api.patch("/api/v1/me", p)).ok;
      if (ok && p.theme) applyTheme(p.theme); // the cookie, so the next server render matches at once
      return ok;
    },
    async savePreferences(preferences: PreferencesPatch) {
      return (await api.patch("/api/v1/me", { preferences })).ok;
    },
    async markStep(step: OnboardingStepId) {
      await api.put("/api/v1/me/onboarding", { step });
    },
    async skipStep(step: OnboardingStepId) {
      await api.put("/api/v1/me/onboarding", { skip: step });
    },
    async complete() {
      await api.put("/api/v1/me/onboarding", { completed: true });
    },
    async startEnrolment() {
      const r = await api.post<{ secret: string; otpauthUri: string }>("/api/v1/me/2fa/enrol");
      return r.ok ? r.data : null;
    },
    async confirmEnrolment(
      code: string,
    ): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; message: string }> {
      const r = await api.post<{ recoveryCodes: string[] }>("/api/v1/me/2fa/confirm", { code });
      if (r.ok) return { ok: true, recoveryCodes: r.data.recoveryCodes };
      return {
        ok: false,
        message:
          r.code === "INVALID_CODE"
            ? "That code didn’t work. Check the time on your phone, then try the next one."
            : r.message,
      };
    },
    async listPeople(): Promise<Person[]> {
      const r = await api.get<{ users: UserRow[] }>("/api/v1/users");
      if (!r.ok) return [];
      return r.data.users
        .filter((u) => u.status !== "disabled")
        .map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.isOwner ? "Owner" : (u.roles[0]?.name ?? "No role"),
          pending: u.status === "invited",
        }));
    },
    /** Only the roles this person may give (the API applies the escalation rule). */
    async listRoles(): Promise<{ id: string; name: string }[]> {
      const r = await api.get<{ roles: { id: string; name: string }[] }>("/api/v1/roles/assignable");
      return r.ok ? r.data.roles.map((x) => ({ id: x.id, name: x.name })) : [];
    },
    async invite(email: string, name: string, roleId: string): Promise<{ ok: boolean; message?: string }> {
      const r = await api.post("/api/v1/invites", { email, name, roleIds: [roleId] });
      return r.ok ? { ok: true } : { ok: false, message: r.message };
    },
    async listPipeline(): Promise<Pipeline | null> {
      const r = await api.get<{ pipelines: (Pipeline & { isDefault: boolean })[] }>("/api/v1/pipelines");
      if (!r.ok) return null;
      return r.data.pipelines.find((p) => p.isDefault) ?? r.data.pipelines[0] ?? null;
    },
    async renameStage(id: string, name: string) {
      return (await api.patch(`/api/v1/stages/${id}`, { name })).ok;
    },
    async reorderStages(pipelineId: string, stageIds: string[]) {
      return (await api.put(`/api/v1/pipelines/${pipelineId}/stage-order`, { stageIds })).ok;
    },
  };
}

export type OnboardingActions = ReturnType<typeof onboardingActions>;
