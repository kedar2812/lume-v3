import { randomUUID } from "node:crypto";
import pg from "pg";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { history, inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";

/**
 * Stop, everywhere (W2, spec 2026-10-18 §5.1): a lead who says stop on WhatsApp, in any words LUME knows, is marked do
 * not contact at once, whoever owns them and whether or not LUME AI is talking to them; the owner hears; a person can
 * lift it, and a later stop sets it again.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
const SNEHA = "+919876543210";

const as = (u: U) => h.signIn(u);
const writes = async (text: string, o: { at?: Date } = {}) => {
  const body = inbound({
    from: SNEHA.slice(1),
    id: `wamid.${randomUUID()}`,
    at: (o.at ?? h.clock.now).toISOString(),
    type: "text",
    text: { body: text },
  });
  expect((await deliver(h, body)).statusCode).toBe(200);
  await h.runWhatsApp();
};
const dncOf = async (lead: string) =>
  (
    await h.queryAll<{ dnc_at: Date | null; dnc_by: string | null; dnc_reason: string | null }>(
      "SELECT dnc_at, dnc_by, dnc_reason FROM leads WHERE id = $1",
      [lead],
    )
  )[0]!;
/** Notices are row-level secured: the backup role reads them all, as other tests do. */
const noticesFor = async (u: U, leads: string[]) => {
  const reader = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
  await reader.connect();
  try {
    return (
      await reader.query<{ kind: string; title: string }>(
        "SELECT kind, title FROM notifications WHERE user_id = $1 AND kind = 'lead_stopped' AND lead_id = ANY($2) ORDER BY created_at",
        [u.id, leads],
      )
    ).rows;
  } finally {
    await reader.end();
  }
};

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "leads.edit", scope: "own" },
      { key: "messages.send", scope: "own" },
    ],
    totp: false,
  });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  h.whatsappQueued.length = 0;
  await seedNumber(h, { runAs: admin.id, owner: rep.id });
});

describe("a stop on WhatsApp, for every lead", () => {
  it("in any words LUME knows: do not contact at once, said by nobody, and the lead's owner hears", async () => {
    const leads: string[] = [];
    for (const words of ["Please stop messaging me", "band karo ye messages", "لا تراسلني"]) {
      await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
      const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
      leads.push(lead);
      await writes(words);
      expect(await dncOf(lead), words).toMatchObject({ dnc_by: null, dnc_reason: "Said stop on WhatsApp" });
      expect((await dncOf(lead)).dnc_at).not.toBeNull();
    }
    expect(await noticesFor(rep, leads)).toEqual([
      { kind: "lead_stopped", title: "Sneha asked not to be messaged" },
      { kind: "lead_stopped", title: "Sneha asked not to be messaged" },
      { kind: "lead_stopped", title: "Sneha asked not to be messaged" },
    ]);
    // On the lead's timeline, with why.
    const acts = await h.queryAll<{ type: string }>(
      "SELECT type FROM activities a JOIN leads l ON l.id = a.lead_id WHERE l.deleted_at IS NULL AND a.type = 'dnc_set'",
    );
    expect(acts).toHaveLength(1);
  });

  it("every lead with their number, whoever owns it, is do not contact: they asked, not one lead (review W5)", async () => {
    const mine = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const twin = await h.seedLead({ ownerId: admin.id, name: "Sneha R (site visit)", phone: SNEHA });
    const other = await h.seedLead({ ownerId: rep.id, name: "Kiran Dsouza", phone: "+919811122233" });
    await writes("Please stop messaging me");
    for (const lead of [mine, twin])
      expect(await dncOf(lead), lead).toMatchObject({ dnc_by: null, dnc_reason: "Said stop on WhatsApp" });
    expect((await dncOf(twin)).dnc_at).not.toBeNull();
    expect((await dncOf(other)).dnc_at).toBeNull();
    // Each one's timeline says so.
    expect(
      await h.queryAll(
        "SELECT lead_id FROM activities WHERE type = 'dnc_set' AND lead_id = ANY($1) ORDER BY lead_id",
        [[mine, twin]],
      ),
    ).toHaveLength(2);
  });

  it("not a stop: a question with the word in it, or a stop from past chats", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes("Can you stop by on Saturday to see the site?");
    expect((await dncOf(lead)).dnc_at).toBeNull();
    const old = new Date(h.clock.now.getTime() - 30 * 86_400_000).toISOString();
    expect(
      (
        await deliver(
          h,
          history([
            {
              id: SNEHA.slice(1),
              messages: [{ from: SNEHA.slice(1), id: "wamid.OLD1", at: old, text: "stop" }],
            },
          ]),
        )
      ).statusCode,
    ).toBe(200);
    await h.runWhatsApp();
    expect((await dncOf(lead)).dnc_at).toBeNull();
    expect(await noticesFor(rep, [lead])).toEqual([]);
  });

  it("already do not contact: left as it was, nobody told twice; lifted by a person, a new stop sets it again", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes("stop");
    const first = await dncOf(lead);
    await writes("STOP!!");
    expect(await dncOf(lead)).toEqual(first);
    expect(await noticesFor(rep, [lead])).toHaveLength(1);
    const lifted = await (
      await as(admin)
    ).inject({ method: "DELETE", url: `/api/v1/leads/${lead}/do-not-contact` });
    expect(lifted.statusCode).toBe(200);
    await writes("Please stop");
    expect((await dncOf(lead)).dnc_reason).toBe("Said stop on WhatsApp");
    expect(await noticesFor(rep, [lead])).toHaveLength(2);
  });

  it("an unowned lead: still do not contact, nobody to tell", async () => {
    const lead = await h.seedLead({ ownerId: null, name: "Sneha Reddy", phone: SNEHA });
    await writes("unsubscribe");
    expect((await dncOf(lead)).dnc_reason).toBe("Said stop on WhatsApp");
  });
});
