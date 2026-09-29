"use client";
import { api } from "@/lib/api";

/** A saved view as the API shows it (4B): the list's filters under a name, a person's own or shared. */
export type ViewView = {
  id: string;
  name: string;
  color: string;
  filters: Record<string, string>;
  sharedRoleIds: string[];
  shared: boolean;
  mine: boolean;
  canEdit: boolean;
};
export type ViewInput = {
  name: string;
  color: string;
  filters: Record<string, string>;
  sharedRoleIds?: string[];
};
export type RoleName = { id: string; name: string };

/** Said on window whenever a view is saved, changed or deleted, so the sidebar looks again. */
export const VIEWS_CHANGED = "lume:views-changed";
export const viewsChanged = () => window.dispatchEvent(new Event(VIEWS_CHANGED));

const one = (id: string) => `/api/v1/views/${encodeURIComponent(id)}`;
export const viewsClient = {
  list: () => api.get<{ views: ViewView[]; roles?: RoleName[] }>("/api/v1/views"),
  counts: () => api.get<{ counts: Record<string, number | null> }>("/api/v1/views/counts"),
  create: (b: ViewInput) => api.post<ViewView>("/api/v1/views", b),
  update: (id: string, b: Partial<ViewInput>) => api.patch<ViewView>(one(id), b),
  remove: (id: string) => api.del<null>(one(id)),
  restore: (id: string) => api.post<ViewView>(`${one(id)}/restore`),
  order: (ids: string[]) => api.put<{ views: ViewView[] }>("/api/v1/views/order", { ids }),
};
