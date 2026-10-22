import { ALL_GRANTS, DEFAULT_AI_PROFILE, AUTOPILOT_PRESETS, defaultGoalStages } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { tinyPdf } from "../../../test/render-fake";

/** Settings → LUME AI on the server (Autopilot A1, Task 5): what LUME AI knows, its voice, the standing choices. */
let h: Harness;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
let messenger: U;
let open: { id: string; name: string; afterReplyStageId: string | null }[];
let won: string;
let currency: string;

const as = (u: U) => h.signIn(u);
const get = async (u: U = admin) => (await as(u)).inject({ method: "GET", url: "/api/v1/ai/profile" });
const patch = async (body: unknown, u: U = admin) =>
  (await as(u)).inject({ method: "PATCH", url: "/api/v1/ai/profile", payload: body as object });
const upload = async (name: string) =>
  (
    await (
      await as(admin)
    ).inject({
      method: "POST",
      url: "/api/v1/files",
      headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
      payload: tinyPdf([name]),
    })
  ).json().file.id as string;

beforeAll(async () => {
  h = await createHarness();
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
  messenger = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "messages.send", scope: null },
    ],
    totp: false,
  });
  const { pipelineId } = await h.config();
  const stages = await h.ownerPool.query<{
    id: string;
    name: string;
    kind: string;
    after_reply_stage_id: string | null;
  }>(
    "SELECT id, name, kind, after_reply_stage_id FROM stages WHERE pipeline_id = $1 AND archived_at IS NULL ORDER BY position",
    [pipelineId],
  );
  open = stages.rows
    .filter((s) => s.kind === "open")
    .map((s) => ({ id: s.id, name: s.name, afterReplyStageId: s.after_reply_stage_id }));
  won = stages.rows.find((s) => s.kind === "won")!.id;
  currency = (await h.ownerPool.query<{ currency: string }>("SELECT currency FROM settings WHERE id = 1"))
    .rows[0]!.currency;
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM ai_profile");
  await h.ownerPool.query("DELETE FROM message_files");
});

describe("Settings → LUME AI on the server", () => {
  it("before anything is saved: the defaults, with goal stages from the business's own pipeline", async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.profile).toEqual({
      ...DEFAULT_AI_PROFILE,
      standing: { ...DEFAULT_AI_PROFILE.standing, goalStages: defaultGoalStages(open) },
    });
    expect(body.profile.standing.goalStages.length).toBeGreaterThan(0);
    expect(body.currency).toBe(currency);
    expect(body.stages.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name }))).toEqual(
      open.map((s) => ({ id: s.id, name: s.name })),
    );
    expect(body.files).toEqual([]);
    expect(body.speakers.map((p: { id: string }) => p.id).sort()).toEqual([admin.id, messenger.id].sort());
  });

  it("an admin saves what LUME AI knows and reads it back; prices keep their value", async () => {
    const prices = [
      { id: crypto.randomUUID(), item: "Modular kitchen", price: 380000, unit: "per kitchen", notes: "" },
      {
        id: crypto.randomUUID(),
        item: "Design visit",
        price: 1150.5,
        unit: "per visit",
        notes: "Waived on signing",
      },
    ];
    const r = await patch({
      knows: {
        about: "We design homes and offices.",
        faqs: [{ q: "Do you visit?", a: "Yes, within the city." }],
        prices,
      },
      voice: { tone: "formal", signOff: "Team Brightpath" },
      standing: { permissions: { mark_lost: "never" }, followUpDays: [3, 7] },
    });
    expect(r.statusCode).toBe(200);
    const saved = (await get()).json().profile;
    expect(saved.knows.prices).toEqual(prices);
    expect(saved.knows.about).toBe("We design homes and offices.");
    expect(saved.voice).toEqual({ tone: "formal", language: "match_lead", signOff: "Team Brightpath" });
    expect(saved.standing.permissions).toEqual({ ...AUTOPILOT_PRESETS.balanced, mark_lost: "never" });
    expect(saved.standing.followUpDays).toEqual([3, 7]);
    // A second patch changes only what it names.
    await patch({ voice: { tone: "casual" } });
    const again = (await get()).json().profile;
    expect(again.voice.signOff).toBe("Team Brightpath");
    expect(again.knows.prices).toEqual(prices);
  });

  it("two admins saving different sections at once both keep theirs", async () => {
    // A profile already saved: the race is two read-merge-writes of the same row. Another connection holds the row
    // until both saves are waiting on it, so they truly overlap (left to timing, they rarely would).
    await patch({ voice: { tone: "formal" } });
    const [c1, c2] = [await as(admin), await as(admin)];
    const holder = await h.ownerPool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM ai_profile WHERE id = 1 FOR UPDATE");
    const saves = Promise.all([
      c1.inject({
        method: "PATCH",
        url: "/api/v1/ai/profile",
        payload: { voice: { signOff: "Team Brightpath" } },
      }),
      c2.inject({
        method: "PATCH",
        url: "/api/v1/ai/profile",
        payload: { knows: { about: "We design homes." } },
      }),
    ]);
    // Both saves waiting on the held row (at its lock, or at the write), each a lock not yet granted.
    const waiting = async () =>
      Number((await h.ownerPool.query("SELECT count(*) FROM pg_locks WHERE NOT granted")).rows[0].count);
    for (let i = 0; i < 100 && (await waiting()) < 2; i++) await new Promise((r) => setTimeout(r, 20));
    await holder.query("COMMIT");
    holder.release();
    const [a, b] = await saves;
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const saved = (await get()).json().profile;
    expect(saved.voice.signOff).toBe("Team Brightpath");
    expect(saved.knows.about).toBe("We design homes.");
  });

  it("a refusal is said in words", async () => {
    const r = await patch({
      knows: { prices: [{ id: crypto.randomUUID(), item: "Sofa", price: -1, unit: "", notes: "" }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe("A price can't be below zero.");
    expect((await patch({ standing: { botQuestion: "deny" } })).statusCode).toBe(400);
  });

  it("a file that isn't in Media is refused; an archived file is said", async () => {
    const brochure = await upload("Brochure.pdf");
    const rates = await upload("Rates.pdf");
    const missing = await patch({ knows: { files: [brochure, crypto.randomUUID()] } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toBe("A file chosen for LUME AI isn't in Media.");

    expect((await patch({ knows: { files: [brochure, rates] } })).statusCode).toBe(200);
    await (await as(admin)).inject({ method: "POST", url: `/api/v1/files/${rates}/archive` });
    const body = (await get()).json();
    expect(body.files).toEqual([
      { id: brochure, name: "Brochure.pdf", archived: false },
      { id: rates, name: "Rates.pdf", archived: true },
    ]);
    // Choosing an archived file anew is refused; keeping one already chosen isn't (it's said, with Remove).
    expect((await patch({ knows: { files: [brochure, rates] } })).statusCode).toBe(200);
    await patch({ knows: { files: [brochure] } });
    const again = await patch({ knows: { files: [brochure, rates] } });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toBe("That file is archived in Media. Restore it to choose it.");
  });

  it("goal stages must be the business's open stages", async () => {
    const wonStage = await patch({ standing: { goalStages: [won] } });
    expect(wonStage.statusCode).toBe(400);
    expect(wonStage.json().error.message).toBe("A goal is one of your open stages.");
    expect((await patch({ standing: { goalStages: [crypto.randomUUID()] } })).statusCode).toBe(400);
    expect((await patch({ standing: { goalStages: [open.at(-1)!.id] } })).statusCode).toBe(200);
    expect((await get()).json().profile.standing.goalStages).toEqual([open.at(-1)!.id]);
  });

  it("the speaker must be someone who may send messages", async () => {
    const no = await patch({ standing: { speaker: rep.id } });
    expect(no.statusCode).toBe(400);
    expect(no.json().error.message).toBe("LUME AI can only speak as someone who may send messages.");
    expect((await patch({ standing: { speaker: messenger.id } })).statusCode).toBe(200);
    expect((await patch({ standing: { speaker: null } })).statusCode).toBe(200);
  });

  it("a rep gets 403", async () => {
    expect((await get(rep)).statusCode).toBe(403);
    expect((await patch({ voice: { tone: "casual" } }, rep)).statusCode).toBe(403);
  });

  it("the audit says which sections changed, never the words", async () => {
    await patch({ knows: { about: "A secret recipe." }, voice: { tone: "casual" } });
    const { rows } = await h.ownerPool.query<{ diff: unknown }>(
      "SELECT diff FROM audit_log WHERE action = 'ai_profile.updated' ORDER BY id DESC LIMIT 1",
    );
    expect(rows[0]?.diff).toEqual({ sections: ["knows", "voice"] });
    expect(JSON.stringify(rows[0]?.diff)).not.toContain("secret");
  });
});
