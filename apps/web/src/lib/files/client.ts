"use client";
import { api } from "@/lib/api";

/** How LUME's viewer shows a file, and what it shows of it before it's opened (Media, plan 2026-10-20-media-tab). */
export type ViewAs = "image" | "video" | "audio" | "pdf" | "office" | "sheet" | "text";
export type PreviewState = "pending" | "ready" | "none" | "failed";

/** A file in the business's library (plan W3b-1): kept once on this server, sent from any lead. */
export type LibraryFile = {
  id: string;
  name: string;
  kind: "image" | "video" | "audio" | "document";
  mime: string;
  size: number;
  /** The share link: its address only while it's on. */
  link: { on: boolean; url: string | null; opens: number };
  createdAt: string;
  archived: boolean;
  viewAs: ViewAs;
  preview: PreviewState;
  /** The thumbnail of its content; its address changes with it, so a browser never shows an old one. */
  thumbUrl: string | null;
  pages: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
};

const one = (id: string) => `/api/v1/files/${encodeURIComponent(id)}`;
/** The file itself, read in LUME's viewer (byte ranges, so a video seeks). */
export const contentUrl = (id: string) => `${one(id)}/content`;
/** A Word or PowerPoint file's pages, made once on the server. */
export const pdfUrl = (id: string) => `${one(id)}/pdf`;

/** The file library's routes (W3b-1 Task 2): reading for anyone who may use templates, the rest for admins. */
export const filesClient = {
  list: (archived = false) =>
    api.get<{ files: LibraryFile[] }>(`/api/v1/files${archived ? "?archived=1" : ""}`),
  upload: (file: File) => api.upload<{ file: LibraryFile }>("/api/v1/files", file),
  uploadWithProgress: (file: File, onProgress: (share: number) => void) =>
    api.uploadWithProgress<{ file: LibraryFile }>("/api/v1/files", file, onProgress),
  rename: (id: string, name: string) => api.patch<{ file: LibraryFile }>(one(id), { name }),
  archive: (id: string) => api.post<{ file: LibraryFile }>(`${one(id)}/archive`),
  restore: (id: string) => api.post<{ file: LibraryFile }>(`${one(id)}/restore`),
  /** Deleted for good (owner, 2026-10-25): messages that already sent it keep it. */
  remove: (id: string) => api.del<null>(one(id)),
  setLink: (id: string, on: boolean) => api.put<{ file: LibraryFile }>(`${one(id)}/link`, { on }),
  /** A preview that failed, tried again (admins). */
  retryPreview: (id: string) => api.post<{ file: LibraryFile }>(`${one(id)}/preview`),
  /** Media's guide put away: remembered for this person on every device. */
  putAwayGuide: () => api.patch<unknown>("/api/v1/me", { preferences: { hints: { mediaGuide: true } } }),
};
