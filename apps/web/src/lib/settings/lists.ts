"use client";
import { api } from "@/lib/api";
import type { LostReason, Product, Tag } from "@/lib/leads/types";

/** The short lists people pick from: lost reasons, tags and packages. Each returns ApiResult. */
export const listsClient = {
  createReason: (label: string) => api.post<{ lostReason: LostReason }>("/api/v1/lost-reasons", { label }),
  patchReason: (id: string, patch: { label?: string; position?: number }) =>
    api.patch<{ lostReason: LostReason }>(`/api/v1/lost-reasons/${id}`, patch),
  archiveReason: (id: string) => api.post<null>(`/api/v1/lost-reasons/${id}/archive`),
  createTag: (input: { label: string; color: string }) => api.post<{ tag: Tag }>("/api/v1/tags", input),
  patchTag: (id: string, patch: { label?: string; color?: string }) =>
    api.patch<{ tag: Tag }>(`/api/v1/tags/${id}`, patch),
  deleteTag: (id: string) => api.del<null>(`/api/v1/tags/${id}`),
  createProduct: (input: { name: string; defaultValue: number | null }) =>
    api.post<{ product: Product }>("/api/v1/products", input),
  patchProduct: (id: string, patch: { name?: string; defaultValue?: number | null }) =>
    api.patch<{ product: Product }>(`/api/v1/products/${id}`, patch),
  archiveProduct: (id: string) => api.post<null>(`/api/v1/products/${id}/archive`),
};
