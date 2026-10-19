"use client";
import { api } from "@/lib/api";
import type { IntegrationsView } from "@/lib/sheets/types";
import type {
  KeepMonths,
  KeepPreview,
  WaInboxMessage,
  WaMediaInfo,
  WaNumbers,
  WaPerson,
  WaThread,
} from "./types";

const person = (numberId: string, peer: string) =>
  `/api/v1/whatsapp/inbox/${encodeURIComponent(numberId)}/${encodeURIComponent(peer)}`;

/** WhatsApp (spec 2026-10-18 §3–4): the switch and numbers (admins), a file's state, and Not a lead yet. */
export const whatsappClient = {
  setEnabled: (enabled: boolean) => api.put<IntegrationsView>("/api/v1/integrations/whatsapp", { enabled }),
  setKeepFiles: (keepFilesMonths: KeepMonths) =>
    api.put<IntegrationsView>("/api/v1/integrations/whatsapp", { keepFilesMonths }),
  keepPreview: (months: Exclude<KeepMonths, null>) =>
    api.get<KeepPreview>(`/api/v1/whatsapp/files/keep-preview?months=${months}`),
  connect: () => api.post<{ url: string }>("/api/v1/whatsapp/connect"),
  complete: (b: { p: string; s: string }) => api.post<WaNumbers>("/api/v1/whatsapp/connect/complete", b),
  numbers: () => api.get<WaNumbers>("/api/v1/whatsapp/numbers"),
  setOwner: (id: string, ownerId: string | null) =>
    api.patch<WaNumbers>(`/api/v1/whatsapp/numbers/${encodeURIComponent(id)}`, { ownerId }),
  disconnect: (id: string) => api.del<WaNumbers>(`/api/v1/whatsapp/numbers/${encodeURIComponent(id)}`),
  people: () => api.get<{ people: { id: string; name: string; active: boolean }[] }>("/api/v1/people"),
  thread: (leadId: string) => api.get<WaThread>(`/api/v1/leads/${encodeURIComponent(leadId)}/whatsapp`),
  mediaInfo: (id: string) => api.get<WaMediaInfo>(`/api/v1/whatsapp/media/${encodeURIComponent(id)}/info`),
  inbox: () => api.get<{ people: WaPerson[] }>("/api/v1/whatsapp/inbox"),
  inboxPerson: (numberId: string, peer: string) =>
    api.get<{ messages: WaInboxMessage[] }>(person(numberId, peer)),
  makeLead: (numberId: string, peer: string) =>
    api.post<{ leadId: string }>(`${person(numberId, peer)}/lead`),
  ignore: (numberId: string, peer: string) => api.post<{ ignored: true }>(`${person(numberId, peer)}/ignore`),
};
/** Where a file is fetched from: the API, cookie-authenticated, row-level security deciding. */
export const mediaUrl = (id: string) => `/api/v1/whatsapp/media/${encodeURIComponent(id)}`;
