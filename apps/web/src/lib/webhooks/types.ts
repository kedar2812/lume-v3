/** Webhooks (2C spec §7): what the API returns. The secret is only ever in a create or rotate answer. */
export type WebhookPreset = "website" | "zapier" | "make" | "manychat";
export type WebhookMode = "signed" | "token";
export type WebhookStatus = "draft" | "active" | "paused" | "needs_attention";
export type RejectReason =
  | "stale_timestamp"
  | "bad_signature"
  | "bad_token"
  | "rate_limited"
  | "too_large"
  | "bad_json"
  | "not_object"
  | "unsupported_type";

export type WebhookView = {
  id: string;
  name: string;
  status: WebhookStatus;
  attention: { code: string; message: string } | null;
  preset: WebhookPreset;
  mode: WebhookMode;
  address: string;
  lastEventAt: string | null;
  eventsToday: number;
  eventsAllTime: number;
  created: number;
  merged: number;
  problems: number;
  rejected: number;
  lastRejectedReason: RejectReason | null;
  newColumns: string[];
  runAs: { id: string; name: string } | null;
};
export type WebhookEventView = {
  id: number;
  receivedAt: string;
  status: "queued" | "done" | "error" | "dismissed";
  result: "created" | "merged" | "skipped" | null;
  leadId: string | null;
};
export type WebhookProblem = {
  id: number;
  receivedAt: string;
  problems: { code: string; message: string }[];
};
export type WebhookDetail = WebhookView & { events: WebhookEventView[]; problemEvents: WebhookProblem[] };
export type WebhookCreated = { source: WebhookView; address: string; secret: string; mode: WebhookMode };
export type TestPost = { paths: string[]; unmappable: string[]; receivedAt: string };
