"use client";
import { api } from "@/lib/api";

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
};

const one = (id: string) => `/api/v1/files/${encodeURIComponent(id)}`;

/** The file library's routes (W3b-1 Task 2): reading for anyone who may use templates, the rest for admins. */
export const filesClient = {
  list: (archived = false) =>
    api.get<{ files: LibraryFile[] }>(`/api/v1/files${archived ? "?archived=1" : ""}`),
  upload: (file: File) => api.upload<{ file: LibraryFile }>("/api/v1/files", file),
  rename: (id: string, name: string) => api.patch<{ file: LibraryFile }>(one(id), { name }),
  archive: (id: string) => api.post<{ file: LibraryFile }>(`${one(id)}/archive`),
  restore: (id: string) => api.post<{ file: LibraryFile }>(`${one(id)}/restore`),
  setLink: (id: string, on: boolean) => api.put<{ file: LibraryFile }>(`${one(id)}/link`, { on }),
};
