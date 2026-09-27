"use client";
import { api } from "@/lib/api";
import type {
  Delimiter,
  DraftView,
  Encoding,
  ImportView,
  Mapping,
  PreviewResult,
  RowView,
  Rules,
} from "./types";

const base = "/api/v1/imports";

export type DraftPatch = Partial<{
  encoding: Encoding;
  delimiter: Delimiter;
  headerRow: number;
  mapping: Mapping;
  rules: Rules;
}>;

export const importsClient = {
  upload: (file: File) => api.upload<DraftView>(base, file),
  draft: (id: string) => api.get<DraftView>(`${base}/${id}/draft`),
  patch: (id: string, p: DraftPatch) => api.patch<DraftView>(`${base}/${id}`, p),
  preview: (id: string, o: { rows?: number[]; errorsOnly?: boolean } = {}) =>
    api.post<PreviewResult>(`${base}/${id}/preview`, o),
  start: (id: string) => api.post<ImportView>(`${base}/${id}/start`),
  cancel: (id: string) => api.post<ImportView>(`${base}/${id}/cancel`),
  resume: (id: string) => api.post<ImportView>(`${base}/${id}/resume`),
  seen: (id: string) => api.post<null>(`${base}/${id}/seen`),
  discard: (id: string) => api.del<null>(`${base}/${id}`),
  get: (id: string) => api.get<ImportView>(`${base}/${id}`),
  list: (cursor?: string) =>
    api.get<{ imports: ImportView[]; nextCursor: string | null }>(
      `${base}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  rows: (id: string, q: { result?: RowView["result"]; cursor?: number } = {}) => {
    const qs = new URLSearchParams();
    if (q.result) qs.set("result", q.result);
    if (q.cursor !== undefined) qs.set("cursor", String(q.cursor));
    const s = qs.toString();
    return api.get<{ rows: RowView[]; nextCursor: number | null }>(`${base}/${id}/rows${s ? `?${s}` : ""}`);
  },
  /** Where the failed-rows CSV downloads from (a plain link: the browser saves it). */
  errorsCsvUrl: (id: string) => `${base}/${id}/errors.csv`,
};
