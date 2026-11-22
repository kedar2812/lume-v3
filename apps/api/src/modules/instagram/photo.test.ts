import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IGSID, igDm } from "../../../../../packages/core/src/instagram/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { deliverIg, IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { IG_PHOTO_MAX } from "./photo";

/**
 * Instagram profile photos on leads (1B addendum, owner 2026-11-22): read once the person has written, kept on this
 * server (never Meta's expiring link), shown wherever the lead's name shows, checked again a week later.
 */
const DAY = 86_400_000;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("a jpeg's bytes")]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("png"),
]);
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };
let account: { id: string; sourceId: string };
let n = 0;

const pic = (name: string, type: string, bytes: Buffer) => {
  ig.files.set(name, { type, bytes });
  return `${ig.graphUrl}/cdn/${name}`;
};
const hasPic = (url?: string) =>
  ig.profiles.set(IGSID, { name: "Priya Shah", username: "priya.fit", ...(url ? { profile_pic: url } : {}) });
const write = async () => {
  await deliverIg(h, igDm({ mid: `m${++n}`, text: "hi", at: h.clock.now.toISOString() }));
  await h.runInstagram();
};
const thread = async () =>
  (
    await h.queryAll<{
      id: string;
      lead_id: string;
      photo_sha256: string | null;
      photo_checked_at: Date | null;
    }>("SELECT id, lead_id, photo_sha256, photo_checked_at FROM instagram_threads")
  )[0]!;
const refs = async (sha: string) =>
  (await h.ownerPool.query<{ refs: number }>("SELECT refs FROM whatsapp_files WHERE sha256 = $1", [sha]))
    .rows[0]?.refs;
const leadOf = async (as = admin) => {
  const t = await thread();
  const r = await (await h.signIn(as)).inject({ method: "GET", url: `/api/v1/leads/${t.lead_id}` });
  return r.json().lead as { id: string; photo?: string | null };
};
const served = async (url: string, as = admin) => (await h.signIn(as)).inject({ method: "GET", url });
const cdnCalls = () => ig.calls.filter((c) => c.path.startsWith("/cdn/")).length;

beforeAll(async () => {
  ig = await startInstagramFake();
  h = await createHarness({
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
  });
  h.setRelayUrl("https://relay.test");
  h.clock.now = new Date("2026-11-22T06:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  h.clock.advance(DAY);
  await h.ownerPool.query(
    // The file store too: a truncate skips the row triggers that keep its counts.
    "TRUNCATE leads, activities, instagram_threads, instagram_events, instagram_comments, instagram_outbox, whatsapp_files CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  h.instagramQueued.length = 0;
  h.instagramPhotoQueued.length = 0;
  ig.files.clear();
  ig.failPaths.clear();
  ig.profileFailNext.length = 0;
  ig.beforeFile = null;
  ig.calls.length = 0;
  ig.tokens.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  hasPic(pic("p1.jpg", "image/jpeg", JPEG));
  account = await seedIgAccount(h, { runAs: admin.id });
});

describe("a person who wrote", () => {
  it("their photo is kept on this server and served with the lead: never Meta's link, still there when Meta's is gone", async () => {
    await write();
    expect(h.instagramPhotoQueued).toHaveLength(1);
    await h.runInstagramPhoto();
    const lead = await leadOf();
    expect(lead.photo).toMatch(new RegExp(`^/api/v1/leads/${lead.id}/photo\\?v=[0-9a-f]{12}$`));
    expect(JSON.stringify(lead)).not.toContain("/cdn/");
    ig.files.clear();
    const r = await served(lead.photo!);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    expect(r.headers["cache-control"]).toContain("private");
    expect(r.rawPayload.equals(JPEG)).toBe(true);
    const list = await (await h.signIn(admin)).inject({ method: "GET", url: "/api/v1/leads" });
    expect(list.json().items[0].photo).toBe(lead.photo);
  });

  it("no photo on Instagram (privacy, or they've only commented): initials, asked again only after 7 days", async () => {
    hasPic();
    await write();
    await h.runInstagramPhoto();
    expect((await leadOf()).photo).toBeNull();
    expect((await thread()).photo_checked_at).not.toBeNull();
    h.clock.advance(6 * DAY);
    await write();
    expect(h.instagramPhotoQueued).toHaveLength(0);
    h.clock.advance(2 * DAY);
    await write();
    expect(h.instagramPhotoQueued).toHaveLength(1);
  });

  it("a burst of messages: the photo is fetched once", async () => {
    await write();
    await write();
    await write();
    await h.runInstagramPhoto();
    expect(cdnCalls()).toBe(1);
  });
});

describe("a week later", () => {
  it("a new photo replaces the old; none from Meta drops it; the file store's counts follow", async () => {
    await write();
    await h.runInstagramPhoto();
    const first = (await thread()).photo_sha256!;
    expect(await refs(first)).toBe(1);
    h.clock.advance(8 * DAY);
    hasPic(pic("p2.png", "image/png", PNG));
    await write();
    await h.runInstagramPhoto();
    const second = (await thread()).photo_sha256!;
    expect(second).not.toBe(first);
    expect(await refs(first)).toBe(0);
    expect((await served((await leadOf()).photo!)).headers["content-type"]).toBe("image/png");
    h.clock.advance(8 * DAY);
    hasPic();
    await write();
    await h.runInstagramPhoto();
    expect((await thread()).photo_sha256).toBeNull();
    expect(await refs(second)).toBe(0);
    expect((await leadOf()).photo).toBeNull();
  });

  it("a link off Meta's hosts, a page that isn't an image, an SVG or a photo over the cap: refused, the old one stays", async () => {
    await write();
    await h.runInstagramPhoto();
    const kept = (await thread()).photo_sha256;
    const tries = [
      "https://photos.example.test/p.jpg",
      pic("page.jpg", "image/jpeg", Buffer.from("<html>not a photo</html>")),
      pic("p.svg", "image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')),
      pic("big.jpg", "image/jpeg", Buffer.concat([JPEG, Buffer.alloc(IG_PHOTO_MAX)])),
    ];
    for (const url of tries) {
      h.clock.advance(8 * DAY);
      hasPic(url);
      await write();
      await h.runInstagramPhoto();
      expect((await thread()).photo_sha256).toBe(kept);
      // Refused for good, not tried again (a link or bytes Meta sent won't change by asking twice).
      expect(h.instagramPhotoQueued).toHaveLength(0);
    }
  });

  it("Meta down, on the profile or its CDN: tried again later, nothing marked as checked", async () => {
    await write();
    ig.failPaths.add(`/${IGSID}`);
    await h.runInstagramPhoto();
    expect((await thread()).photo_checked_at).toBeNull();
    expect(h.instagramPhotoQueued).toHaveLength(1);
    ig.failPaths.clear();
    ig.failPaths.add("/cdn/p1.jpg");
    await h.runInstagramPhoto();
    expect((await thread()).photo_checked_at).toBeNull();
    ig.failPaths.clear();
    await h.runInstagramPhoto();
    expect((await thread()).photo_sha256).not.toBeNull();
    expect(h.instagramPhotoQueued).toHaveLength(0);
  });

  it("the account needs connecting again before the job ran: nothing fetched, nothing marked", async () => {
    await write();
    await h.ownerPool.query("UPDATE instagram_accounts SET status = 'needs_attention' WHERE id = $1", [
      account.id,
    ]);
    await h.runInstagramPhoto();
    expect(cdnCalls()).toBe(0);
    expect((await thread()).photo_checked_at).toBeNull();
  });

  it("Meta asks LUME to slow down: the photo kept, asked again later, not marked as checked", async () => {
    await write();
    await h.runInstagramPhoto();
    const before = await thread();
    h.clock.advance(8 * DAY);
    hasPic(pic("p2.png", "image/png", PNG));
    await write();
    ig.profileFailNext.push(4);
    await h.runInstagramPhoto();
    expect((await thread()).photo_sha256).toBe(before.photo_sha256);
    expect((await thread()).photo_checked_at).toEqual(before.photo_checked_at);
    expect(h.instagramPhotoQueued).toHaveLength(1);
    await h.runInstagramPhoto();
    expect((await thread()).photo_sha256).not.toBe(before.photo_sha256);
  });

  it("another refusal keeps the photo (checked); a refusal of consent drops it", async () => {
    await write();
    await h.runInstagramPhoto();
    const kept = (await thread()).photo_sha256;
    h.clock.advance(8 * DAY);
    await write();
    ig.profileFailNext.push(100);
    await h.runInstagramPhoto();
    expect((await thread()).photo_sha256).toBe(kept);
    expect(h.instagramPhotoQueued).toHaveLength(0);
    h.clock.advance(8 * DAY);
    await write();
    ig.profileFailNext.push(230);
    await h.runInstagramPhoto();
    expect((await thread()).photo_sha256).toBeNull();
  });

  it("Meta refuses the token: the account needs attention, the photo as it was", async () => {
    await write();
    ig.tokens.clear();
    await h.runInstagramPhoto();
    const [a] = await h.queryAll<{ status: string }>("SELECT status FROM instagram_accounts");
    expect(a!.status).toBe("needs_attention");
    expect((await thread()).photo_checked_at).toBeNull();
  });
});

describe("who sees it, and when it goes", () => {
  it("Meta's data deletion arriving while the photo is being fetched: the photo isn't put back", async () => {
    await write();
    ig.beforeFile = async () => {
      await h.queryAll("UPDATE instagram_accounts SET status = 'disconnected', token_enc = NULL");
      await h.ownerPool.query("SELECT lume_instagram_forget($1)", [account.id]);
    };
    await h.runInstagramPhoto();
    expect((await thread()).photo_sha256).toBeNull();
  });

  it("two looks at once: the one that finishes second writes nothing over the first", async () => {
    await write();
    ig.beforeFile = () => h.queryAll("UPDATE instagram_threads SET photo_checked_at = now()");
    await h.runInstagramPhoto();
    expect((await thread()).photo_sha256).toBeNull();
  });

  it("the lead purged while the photo is being fetched: nothing written onto the conversation", async () => {
    await write();
    ig.beforeFile = () => h.queryAll("UPDATE instagram_threads SET lead_id = NULL");
    await h.runInstagramPhoto();
    expect((await thread()).photo_sha256).toBeNull();
    expect((await thread()).photo_checked_at).toBeNull();
  });

  it("whoever can't see the lead gets a 404; a role the name is hidden from gets no photo either (a 204)", async () => {
    await write();
    await h.runInstagramPhoto();
    const url = (await leadOf()).photo!;
    const outsider = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    expect((await served(url, outsider)).statusCode).toBe(404);
    const cfg = await h.config();
    const viewer = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
    const {
      rows: [role],
    } = await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [viewer.id]);
    await (
      await h.signIn(admin)
    ).inject({
      method: "PUT",
      url: `/api/v1/roles/${role.role_id}/field-access`,
      payload: { entries: [{ fieldId: cfg.fields.name, access: "hidden" }] },
    });
    await h.waitForRbacNotify();
    expect((await leadOf(viewer)).photo ?? null).toBeNull();
    const hidden = await served(url, viewer);
    expect(hidden.statusCode).toBe(204);
    expect(hidden.rawPayload.length).toBe(0);
  });

  it("a lead in the trash: no photo served; a purge's cascade takes it from the conversation", async () => {
    await write();
    await h.runInstagramPhoto();
    const lead = await leadOf();
    const del = await (await h.signIn(admin)).inject({ method: "DELETE", url: `/api/v1/leads/${lead.id}` });
    expect(del.statusCode).toBeLessThan(300);
    expect((await served(lead.photo!)).statusCode).toBe(404);
  });

  it("purged with the lead, and by Meta's data deletion request; the person writing again is checked afresh", async () => {
    await write();
    await h.runInstagramPhoto();
    const sha = (await thread()).photo_sha256!;
    // What a lead's purge does to its conversations (0118: ON DELETE SET NULL); leads themselves are only trashed.
    await h.queryAll("UPDATE instagram_threads SET lead_id = NULL");
    expect((await thread()).photo_sha256).toBeNull();
    expect((await thread()).photo_checked_at).toBeNull();
    expect(await refs(sha)).toBe(0);
    await write();
    expect(h.instagramPhotoQueued).toHaveLength(1);
    await h.runInstagramPhoto();
    expect((await thread()).photo_sha256).toBe(sha);
    await h.ownerPool.query("SELECT lume_instagram_forget($1)", [account.id]);
    expect((await thread()).photo_sha256).toBeNull();
    expect(await refs(sha)).toBe(0);
  });
});
