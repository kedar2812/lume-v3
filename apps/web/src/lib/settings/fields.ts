"use client";
import { api } from "@/lib/api";
import type { FieldDefView } from "@/lib/leads/types";

export type OptionInput = { id?: string; label: string; color?: string };
export type NewField = {
  key: string;
  label: string;
  type: FieldDefView["type"];
  options?: { label: string }[];
  isRequired: boolean;
};
export type FieldPatch = { label?: string; isRequired?: boolean; options?: OptionInput[] };

/** The field calls Settings makes. Each returns ApiResult, so a refusal can be shown as it is. */
export const fieldsClient = {
  list: () => api.get<{ fields: FieldDefView[] }>("/api/v1/fields"),
  create: (input: NewField) => api.post<{ field: FieldDefView }>("/api/v1/fields", input),
  patch: (id: string, patch: FieldPatch) => api.patch<{ field: FieldDefView }>(`/api/v1/fields/${id}`, patch),
  archive: (id: string) => api.post<null>(`/api/v1/fields/${id}/archive`),
};
