import { ALL_GRANTS, LEGAL_VERSION, RELEASES } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { fakeProvider } from "../../ai/fake";

/** What's new in LUME (spec 2026-11-02): who is shown which stories, and the state kept per person. */
const V = "1.2.0";
const release = RELEASES.find((r) => r.version === V)!;
let h: Harness;

beforeAll(async () => {
  const provider = fakeProvider();
  h = await createHarness({
    version: V,
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
  });
  await h.ownerPool.query(
    `UPDATE settings SET integrations = integrations || '{"ai": {"enabled": true}, "whatsapp": {"enabled": true}}'::jsonb WHERE id = 1`,
  );
});
afterAll(async () => h.close());

/** A person past the agreement and onboarding, who joined before the release unless told otherwise. */
async function person(o: {
  owner?: boolean;
  grants: { key: string; scope: string | null }[];
  joined?: string;
}) {
  // One owner per business: the rest are admins with every grant (two-step on, as their role requires).
  const all = o.grants === ALL_GRANTS;
  const u = await h.seedUser({ owner: o.owner ?? false, grants: o.grants as never, totp: all });
  await h.ownerPool.query(
    `UPDATE users SET agreed_version = $2, onboarding = '{"completedAt": "2026-10-01T00:00:00Z"}'::jsonb,
       created_at = $3 WHERE id = $1`,
    [u.id, LEGAL_VERSION, o.joined ?? "2026-10-01T00:00:00Z"],
  );
  return { ...u, c: await h.signIn(u) };
}
const me = async (c: Awaited<ReturnType<typeof person>>["c"]) =>
  (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
const put = (c: Awaited<ReturnType<typeof person>>["c"], payload: object) =>
  c.inject({ method: "PUT", url: "/api/v1/me/whats-new", payload });

describe("What's new on /auth/me", () => {
  it("an owner is shown every story of the running version, and the window is due", async () => {
    const o = await person({ owner: true, grants: ALL_GRANTS });
    const m = await me(o.c);
    expect(m.whatsNew).toEqual({
      version: V,
      stories: ["calls", "chats", "templates"],
      state: { seen: null, used: [], pillGone: null },
    });
    expect(m.flags.needsWhatsNew).toBe(true);
  });

  it("a rep isn't told about calls (Settings isn't theirs)", async () => {
    const r = await person({ grants: [{ key: "leads.view", scope: "own" }] });
    expect((await me(r.c)).whatsNew.stories).toEqual(["chats"]);
  });

  it("seen once is seen on every device, and seen from a second session too", async () => {
    const o = await person({ grants: ALL_GRANTS });
    const res = await put(o.c, { seen: V });
    expect(res.statusCode).toBe(200);
    expect(res.json().whatsNew.seen).toBe(V);
    expect((await me(o.c)).flags.needsWhatsNew).toBe(false);
    const other = await h.signIn(o);
    expect((await me(other)).flags.needsWhatsNew).toBe(false);
  });

  it("a story used twice is kept once", async () => {
    const o = await person({ grants: ALL_GRANTS });
    await put(o.c, { used: "calls" });
    const res = await put(o.c, { used: "calls" });
    expect(res.json().whatsNew.used).toEqual([`${V}:calls`]);
  });

  it("someone who joined on or after the release day isn't shown the window, and it's kept as seen", async () => {
    const n = await person({ grants: ALL_GRANTS, joined: `${release.date}T00:00:00Z` });
    expect((await me(n.c)).flags.needsWhatsNew).toBe(false);
    const row = await h.ownerPool.query("SELECT whats_new FROM users WHERE id = $1", [n.id]);
    expect(row.rows[0].whats_new.seen).toBe(V);
  });

  it("waits while onboarding or the agreement is due", async () => {
    const o = await person({ grants: ALL_GRANTS });
    await h.ownerPool.query(`UPDATE users SET onboarding = '{}'::jsonb WHERE id = $1`, [o.id]);
    expect((await me(o.c)).flags.needsWhatsNew).toBe(false);
    await h.ownerPool.query(
      `UPDATE users SET onboarding = '{"completedAt": "2026-10-01T00:00:00Z"}'::jsonb, agreed_version = NULL WHERE id = $1`,
      [o.id],
    );
    expect((await me(o.c)).flags.needsWhatsNew).toBe(false);
  });

  it("a version that isn't the running one is refused (a tab from before the update)", async () => {
    const o = await person({ grants: ALL_GRANTS });
    expect((await put(o.c, { seen: "9.9.9" })).statusCode).toBe(409);
    expect((await put(o.c, { pillGone: "1.1.0" })).statusCode).toBe(409);
    expect((await put(o.c, { used: "nope" })).statusCode).toBe(400);
    expect((await me(o.c)).flags.needsWhatsNew).toBe(true);
  });

  it("the pill put away is kept", async () => {
    const o = await person({ grants: ALL_GRANTS });
    expect((await put(o.c, { pillGone: V })).json().whatsNew.pillGone).toBe(V);
    expect((await me(o.c)).whatsNew.state.pillGone).toBe(V);
  });
});
