import { newId, relaySign } from "@lume/core";
import { IG_ACCOUNT } from "../../../packages/core/src/instagram/fixtures";
import { igTokenContext } from "../src/modules/instagram/service";
import type { Harness } from "./harness";

/** Instagram test helpers (plan 1A). Only tests import this file. */
export const IG_RELAY_TOKEN = "r".repeat(40);

/** A delivery as the relay forwards it: signed with this instance's token, at the harness's time. */
export function deliverIg(h: Harness, body: unknown) {
  h.clock.advance(1000);
  const raw = Buffer.from(JSON.stringify(body));
  const ts = String(Math.floor(h.clock.now.getTime() / 1000));
  return h.app.inject({
    method: "POST",
    url: "/instagram/in",
    headers: {
      "content-type": "application/json",
      "x-lume-timestamp": ts,
      "x-lume-signature": relaySign(IG_RELAY_TOKEN, ts, raw),
    },
    payload: raw,
  });
}

/** A connected account with its own lead source, Instagram switched on. Answers the account's and source's ids. */
export async function seedIgAccount(
  h: Harness,
  o: {
    runAs: string;
    owner?: string | null;
    igUserId?: string;
    token?: string;
    newDmCreatesLead?: boolean;
    rules?: Record<string, unknown>;
  },
): Promise<{ id: string; sourceId: string }> {
  const id = newId();
  const sourceId = newId();
  const cfg = await h.config();
  await h.ownerPool.query(
    `INSERT INTO lead_sources (id, type, name, status, rules, run_as, created_by)
     VALUES ($1, 'instagram', 'Instagram @harbour.studio', 'active', $2, $3, $3)`,
    [
      sourceId,
      JSON.stringify(
        o.rules ?? {
          matchOn: ["instagram"],
          onMatch: "merge",
          reopenClosedTo: null,
          pipelineId: cfg.pipelineId,
          stageId: cfg.stages.New,
          owner: { mode: "unassigned" },
          defaultCountry: null,
          noName: "use_contact",
          unknownOwner: "fallback",
          requiredDefaults: {},
        },
      ),
      o.runAs,
    ],
  );
  await h.ownerPool.query(
    `INSERT INTO instagram_accounts (id, ig_user_id, username, owner_user_id, run_as, source_id, status, token_enc,
                                     token_at, new_dm_creates_lead)
     VALUES ($1, $2, 'harbour.studio', $3, $4, $5, 'active', $6, now(), $7)`,
    [
      id,
      o.igUserId ?? IG_ACCOUNT,
      o.owner ?? null,
      o.runAs,
      sourceId,
      h.keyring.encrypt(o.token ?? "IGQlong-account-token", igTokenContext(id)),
      o.newDmCreatesLead ?? true,
    ],
  );
  await h.ownerPool.query(
    `UPDATE settings SET integrations = jsonb_set(integrations, '{instagram}', '{"enabled": true}'::jsonb) WHERE id = 1`,
  );
  return { id, sourceId };
}
