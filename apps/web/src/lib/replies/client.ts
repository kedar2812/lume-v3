"use client";
import type { ReplyMeaningGroup } from "@lume/core/shared";
import { api } from "@/lib/api";

export type ReplyChannel = "whatsapp" | "instagram";
/** The board's groups: a flow's hand-offs first (Instagram, D6a), then what each reply means. */
export type ReplyBoardGroup = "flow_passed" | ReplyMeaningGroup;

/** Who replied (W2; Instagram D6a), as the API says it: each lead's latest reply since a moment, grouped by meaning. */
export type ReplyBoardLead = {
  leadId: string;
  name: string;
  at: string;
  text: string | null;
  /** LUME AI's line on it; null when it wasn't read. */
  summary: string | null;
  doNotContact: boolean;
  /** Where they last wrote. */
  channel: ReplyChannel;
  /** Whether a reply still reaches them there: open (anyone), human (Instagram: a person), closed. */
  window: { state: "open" | "human" | "closed"; until: string | null };
  ownerName: string | null;
  source: string | null;
  /** A flow passed them to the team: its name and what its hand-off said. */
  flow?: { name: string; note: string | null };
};
export type ReplyBoard = {
  since: string;
  channel: ReplyChannel | "all";
  groups: { group: ReplyBoardGroup; count: number; leads: ReplyBoardLead[] }[];
};

export const repliesClient = {
  board: (since: string, channel: ReplyChannel | "all" = "all") =>
    api.get<ReplyBoard>(
      `/api/v1/whatsapp/replies?since=${encodeURIComponent(since)}${channel === "all" ? "" : `&channel=${channel}`}`,
    ),
};
