import { api } from "@/lib/api";

export type AboutInfo = {
  version: string;
  lastRestoreTest: { finishedAt: string; ok: boolean; backup: string | null } | null;
};

export const aboutClient = { get: () => api.get<AboutInfo>("/api/v1/about") };
