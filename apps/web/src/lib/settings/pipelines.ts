"use client";
import { api } from "@/lib/api";
import type { Pipeline, Stage } from "@/lib/leads/types";

export type StagePatch = Partial<Pick<Stage, "name" | "color" | "kind" | "requiredFieldIds" | "slaHours">>;

/** The pipeline and stage calls Settings makes. Each returns ApiResult, so a refusal can be shown as it is. */
export const pipelinesClient = {
  list: () => api.get<{ pipelines: Pipeline[] }>("/api/v1/pipelines"),
  addStage: (pipelineId: string, input: { name: string; kind: Stage["kind"] }) =>
    api.post<{ stage: Stage }>(`/api/v1/pipelines/${pipelineId}/stages`, input),
  reorder: (pipelineId: string, stageIds: string[]) =>
    api.put<{ pipeline: Pipeline }>(`/api/v1/pipelines/${pipelineId}/stage-order`, { stageIds }),
  patchStage: (id: string, patch: StagePatch) => api.patch<{ stage: Stage }>(`/api/v1/stages/${id}`, patch),
  archiveStage: (id: string, moveToStageId?: string) =>
    api.post<null>(`/api/v1/stages/${id}/archive`, moveToStageId ? { moveToStageId } : {}),
};
