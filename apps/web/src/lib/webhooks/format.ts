import { ago } from "@/lib/sheets/format";
import type { RejectReason, WebhookPreset, WebhookView } from "./types";

export const PRESET_LABEL: Record<WebhookPreset, string> = {
  website: "Website form",
  zapier: "Zapier",
  make: "Make",
  manychat: "ManyChat",
};

/** Why LUME refused a post, as the page says it ("last for a bad signature"). */
export const REJECTED: Record<RejectReason, string> = {
  bad_signature: "a bad signature",
  stale_timestamp: "a timestamp more than 5 minutes off (check the sender's clock)",
  bad_token: "a wrong token",
  rate_limited: "too many posts at once",
  too_large: "a post over 64 KB",
  bad_json: "a body that isn't valid JSON",
  not_object: "a JSON list instead of an object",
  unsupported_type: "a body that isn't JSON or a form",
};

const n = (v: number) => v.toLocaleString("en");

/** "Last post 3 min ago · 12 today · 1 problem": is it working, and is it bringing leads? */
export function webhookHealth(v: WebhookView): string {
  if (v.status === "draft") return "Setting up — waiting for a test post";
  const parts = [
    v.lastEventAt ? `Last post ${ago(v.lastEventAt)}` : "No posts yet",
    `${n(v.eventsToday)} today`,
    v.problems ? `${n(v.problems)} ${v.problems === 1 ? "problem" : "problems"}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}
