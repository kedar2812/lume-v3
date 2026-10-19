"use client";
import { api } from "@/lib/api";
import type { IntegrationsView } from "@/lib/sheets/types";
import type {
  KeepMonths,
  WaAttached,
  KeepPreview,
  WaInboxMessage,
  WaMediaInfo,
  WaNumbers,
  WaPerson,
  WaThread,
  WaThreadMessage,
} from "./types";

const person = (numberId: string, peer: string) =>
  `/api/v1/whatsapp/inbox/${encodeURIComponent(numberId)}/${encodeURIComponent(peer)}`;

/** WhatsApp (spec 2026-10-18 §3–4): the switch and numbers (admins), a file's state, and Not a lead yet. */
export const whatsappClient = {
  setEnabled: (enabled: boolean) => api.put<IntegrationsView>("/api/v1/integrations/whatsapp", { enabled }),
  setKeepFiles: (keepFilesMonths: KeepMonths) =>
    api.put<IntegrationsView>("/api/v1/integrations/whatsapp", { keepFilesMonths }),
  setReplyFromLume: (replyFromLume: boolean) =>
    api.put<IntegrationsView>("/api/v1/integrations/whatsapp", { replyFromLume }),
  /** A reply from LUME (plan W3a): `clientKey` makes a retried send the same message, never a second one. */
  send: (leadId: string, body: { clientKey: string; text?: string; mediaId?: string; taskId?: string }) =>
    api.post<{ message: WaThreadMessage }>(
      `/api/v1/leads/${encodeURIComponent(leadId)}/whatsapp/messages`,
      body,
    ),
  attach: (leadId: string, file: File) =>
    api.upload<{ media: WaAttached }>(`/api/v1/leads/${encodeURIComponent(leadId)}/whatsapp/files`, file),
  /** A file from the business's library (W3b-1), attached with nothing uploaded again. */
  attachFromLibrary: (leadId: string, fileId: string) =>
    api.post<{ media: WaAttached }>(`/api/v1/leads/${encodeURIComponent(leadId)}/whatsapp/files/library`, {
      fileId,
    }),
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
