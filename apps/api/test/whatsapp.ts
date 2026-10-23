import { newId, relaySign } from "@lume/core";
import { PHONE_NUMBER_ID } from "../../../packages/core/src/whatsapp/fixtures";
import { tokenContext } from "../src/modules/whatsapp/service";
import type { Harness } from "./harness";

/** WhatsApp test helpers (plan W1). Only tests import this file. */
export const RELAY_TOKEN = "r".repeat(40);

/** A delivery as the relay forwards it: signed with this instance's token, at the harness's time. */
export function deliver(h: Harness, body: unknown) {
  // Each forward is signed when it's sent: a second one is a second later (the same signature twice is a replay).
  h.clock.advance(1000);
  const raw = Buffer.from(JSON.stringify(body));
  const ts = String(Math.floor(h.clock.now.getTime() / 1000));
  return h.app.inject({
    method: "POST",
    url: "/whatsapp/in",
    headers: {
      "content-type": "application/json",
      "x-lume-timestamp": ts,
      "x-lume-signature": relaySign(RELAY_TOKEN, ts, raw),
    },
    payload: raw,
  });
}

/** A connected number, WhatsApp switched on. */
export async function seedNumber(
  h: Harness,
  o: { runAs: string; owner?: string | null; phoneNumberId?: string; token?: string },
): Promise<string> {
  const id = newId();
  await h.ownerPool.query(
    `INSERT INTO whatsapp_numbers (id, phone_number_id, waba_id, display_phone, owner_user_id, run_as, status, token_enc)
     VALUES ($1, $2, '102290129340398', '+91 90000 00001', $3, $4, 'active', $5)`,
    [
      id,
      o.phoneNumberId ?? PHONE_NUMBER_ID,
      o.owner ?? null,
      o.runAs,
      h.keyring.encrypt(o.token ?? "EAAG-business-token", tokenContext(id)),
    ],
  );
  await h.ownerPool.query(
    `UPDATE settings SET integrations = jsonb_set(integrations, '{whatsapp}', '{"enabled": true}'::jsonb) WHERE id = 1`,
  );
  return id;
}

/**
 * A LUME template submitted to WhatsApp and approved by its webhook, as an admin makes one (W3b-2): its submission's id.
 * For tests that need an approved template to send (Autopilot A2).
 */
export async function approvedTemplate(
  h: Harness,
  meta: { templateUpdate(name: string, o: { status: string }): Record<string, unknown> },
  admin: { id: string; email: string; password: string },
  body: string,
  category = "first_touch",
): Promise<string> {
  const as = await h.signIn(admin);
  const t = (
    await as.inject({
      method: "POST",
      url: "/api/v1/templates",
      payload: { name: `T ${newId().slice(-8)}`, category, body },
    })
  ).json() as { id: string };
  const s = await (
    await h.signIn(admin)
  ).inject({
    method: "POST",
    url: `/api/v1/templates/${t.id}/whatsapp`,
    payload: { language: "en" },
  });
  if (s.statusCode !== 202) throw new Error(`template not submitted: ${s.body}`);
  const id = s.json().submissions[0].id as string;
  const [row] = await h.queryAll<{ meta_name: string }>(
    "SELECT meta_name FROM whatsapp_template_submissions WHERE id = $1",
    [id],
  );
  const r = await deliver(h, meta.templateUpdate(row!.meta_name, { status: "APPROVED" }));
  if (r.statusCode !== 200) throw new Error("template not approved");
  return id;
}
