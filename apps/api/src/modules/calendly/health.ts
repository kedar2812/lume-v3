import type pg from "pg";
import type { Keyring } from "@lume/core";
import { CalendlyError, createCalendly } from "./client";
import { openCalendly } from "./config";

/** What LUME says when Calendly stopped sending bookings (never Calendly's own words, never the token). */
const SAID = {
  CALENDLY_TOKEN:
    "Calendly stopped accepting LUME's access token, so bookings aren't arriving. Make a new personal access token in Calendly, then disconnect and connect Calendly again.",
  CALENDLY_SUBSCRIPTION:
    "Calendly stopped sending bookings to LUME (its plan, or the access of the person who connected it, changed). Connect Calendly again.",
  CALENDLY_PLAN:
    "Calendly sends bookings to other apps only on its Standard plan or higher. Upgrade the Calendly account, then connect again.",
} as const;
type Code = keyof typeof SAID;

/**
 * Once a day (5B final review): is Calendly still sending this LUME's bookings? A token it stopped honouring,
 * or a subscription it disabled, needs attention in LUME's words; when all's well again that clears. Calendly
 * being down changes nothing, and a problem LUME said for another reason (who it runs as) is left alone.
 */
export async function checkCalendly(o: {
  pool: pg.Pool;
  keyring: Keyring;
  endpoint?: string;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  const { rows } = await o.pool.query<{
    id: string;
    config_enc: Buffer;
    status: string;
    attention_code: string | null;
  }>(
    "SELECT id, config_enc, status, attention_code FROM lead_sources WHERE type = 'calendly' AND status <> 'archived'",
  );
  for (const s of rows) {
    const c = openCalendly(o.keyring, s.id, s.config_enc);
    const calendly = createCalendly({
      token: c.token,
      ...(o.endpoint ? { endpoint: o.endpoint } : {}),
      ...(o.wait ? { sleep: o.wait } : {}),
    });
    let code: Code | null = null;
    try {
      const sub = await calendly.subscription(c.subscription);
      if (sub.state !== "active") code = "CALENDLY_SUBSCRIPTION";
    } catch (e) {
      if (!(e instanceof CalendlyError) || e.kind === "unavailable") continue; // nothing learned
      code =
        e.kind === "token" ? "CALENDLY_TOKEN" : e.kind === "plan" ? "CALENDLY_PLAN" : "CALENDLY_SUBSCRIPTION";
    }
    const ours = s.attention_code?.startsWith("CALENDLY_") ?? false;
    if (code && (s.status !== "needs_attention" || ours))
      await o.pool.query(
        "UPDATE lead_sources SET status = 'needs_attention', attention_code = $2, last_error = $3 WHERE id = $1",
        [s.id, code, SAID[code]],
      );
    else if (!code && s.status === "needs_attention" && ours)
      await o.pool.query(
        "UPDATE lead_sources SET status = 'active', attention_code = NULL, last_error = NULL WHERE id = $1",
        [s.id],
      );
  }
}
