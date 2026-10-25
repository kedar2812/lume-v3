"use client";
import type { ReplyMeaningGroup } from "@lume/core/shared";
import { api } from "@/lib/api";

/** Who replied (W2), as the API says it: each lead's latest reply since a moment, grouped by what it means. */
export type ReplyBoardLead = {
  leadId: string;
  name: string;
  at: string;
  text: string | null;
  /** LUME AI's line on it; null when it wasn't read. */
  summary: string | null;
  doNotContact: boolean;
};
export type ReplyBoard = {
  since: string;
  groups: { group: ReplyMeaningGroup; count: number; leads: ReplyBoardLead[] }[];
};

export const repliesClient = {
  board: (since: string) =>
    api.get<ReplyBoard>(`/api/v1/whatsapp/replies?since=${encodeURIComponent(since)}`),
};
