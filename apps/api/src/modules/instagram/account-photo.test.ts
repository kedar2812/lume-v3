import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";

/**
 * The connected account's own profile photo in Settings → Integrations → Instagram (owner 2026-11-28: "why is my
 * account pfp not being fetched here ... every synced account's profile photo will be shown"): read with the account's
 * token, kept on this server (Meta's link is signed and expires), initials only when there's none.
 */
const DAY = 86_400_000;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("the account's photo")]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("png"),
]);
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };
let rep: { id: string; email: string; password: string };
let account: { id: string; sourceId: string };

const pic = (name: string, type: string, bytes: Buffer) => {
  ig.files.set(name, { type, bytes });
  return `${ig.graphUrl}/cdn/${name}`;
};
const hasPic = (url?: string) =>
  ig.tokens.set("IGQlong-account-token", fakeAccount(url ? { picture: url } : {}));
const list = async () =>
  (await (await h.signIn(admin)).inject({ method: "GET", url: "/api/v1/instagram/accounts" })).json()
    .accounts as { id: string; photo: string | null }[];
const row = async () =>
  (
    await h.ownerPool.query<{ photo_sha256: string | null; photo_checked_at: Date | null }>(
      "SELECT photo_sha256, photo_checked_at FROM instagram_accounts WHERE id = $1",
      [account.id],
    )
  ).rows[0]!;
const refs = async (sha: string) =>
  (await h.ownerPool.query<{ refs: number }>("SELECT refs FROM whatsapp_files WHERE sha256 = $1", [sha]))
    .rows[0]?.refs;
const cdnCalls = () => ig.calls.filter((c) => c.path.startsWith("/cdn/")).length;

beforeAll(async () => {
  ig = await startInstagramFake();
  h = await createHarness({
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
  });
  h.setRelayUrl("https://relay.test");
  h.clock.now = new Date("2026-11-28T06:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  h.clock.advance(DAY);
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("TRUNCATE whatsapp_files CASCADE");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  h.instagramAccountPhotoQueued.length = 0;
  ig.files.clear();
  ig.failPaths.clear();
  ig.calls.length = 0;
  ig.tokens.clear();
  hasPic(pic("me.jpg", "image/jpeg", JPEG));
  account = await seedIgAccount(h, { runAs: admin.id });
});

describe("the connected account's photo", () => {
  it("asked for when Settings lists the account, kept on this server, served there: never Meta's link", async () => {
    expect((await list())[0]!.photo).toBeNull();
    expect(h.instagramAccountPhotoQueued).toEqual([account.id]);
    await h.runInstagramAccountPhoto();
    const photo = (await list())[0]!.photo!;
    expect(photo).toMatch(new RegExp(`^/api/v1/instagram/accounts/${account.id}/photo\\?v=[0-9a-f]{12}$`));
    expect(JSON.stringify(await list())).not.toContain("/cdn/");
    ig.files.clear();
    const r = await (await h.signIn(admin)).inject({ method: "GET", url: photo });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    expect(r.rawPayload.equals(JPEG)).toBe(true);
    expect(await refs((await row()).photo_sha256!)).toBe(1);
  });

  it("each connected account gets its own photo", async () => {
    const second = await seedIgAccount(h, {
      runAs: admin.id,
      igUserId: "17841400000000002",
      token: "IGQ-second",
    });
    ig.tokens.set(
      "IGQ-second",
      fakeAccount({ userId: "17841400000000002", picture: pic("two.png", "image/png", PNG) }),
    );
    await list();
    expect([...h.instagramAccountPhotoQueued].sort()).toEqual([account.id, second.id].sort());
    await h.runInstagramAccountPhoto();
    const photos = await list();
    expect(photos.every((a) => !!a.photo)).toBe(true);
    expect(new Set(photos.map((a) => a.photo)).size).toBe(2);
  });

  it("no photo on Instagram: initials; looked at again only a week later, not on every visit", async () => {
    hasPic();
    await list();
    await h.runInstagramAccountPhoto();
    expect((await list())[0]!.photo).toBeNull();
    expect((await row()).photo_checked_at).not.toBeNull();
    h.instagramAccountPhotoQueued.length = 0;
    h.clock.advance(6 * DAY);
    await list();
    expect(h.instagramAccountPhotoQueued).toHaveLength(0);
    h.clock.advance(2 * DAY);
    await list();
    expect(h.instagramAccountPhotoQueued).toEqual([account.id]);
  });

  it("a new photo replaces the old a week later, and the file store's counts follow", async () => {
    await list();
    await h.runInstagramAccountPhoto();
    const first = (await row()).photo_sha256!;
    h.clock.advance(8 * DAY);
    hasPic(pic("new.png", "image/png", PNG));
    await list();
    await h.runInstagramAccountPhoto();
    const second = (await row()).photo_sha256!;
    expect(second).not.toBe(first);
    expect(await refs(first)).toBe(0);
    expect(await refs(second)).toBe(1);
    // Removed on Instagram: LUME's copy goes too, and the initials show.
    h.clock.advance(8 * DAY);
    hasPic();
    await list();
    await h.runInstagramAccountPhoto();
    expect((await row()).photo_sha256).toBeNull();
    expect(await refs(second)).toBe(0);
    expect((await list())[0]!.photo).toBeNull();
  });

  it("Settings opened twice before the look: the photo is fetched once", async () => {
    await list();
    await list();
    expect(h.instagramAccountPhotoQueued).toHaveLength(2);
    await h.runInstagramAccountPhoto();
    expect(cdnCalls()).toBe(1);
  });

  it("a queue that won't take the look never fails the page or the server: asked again at the next visit", async () => {
    const real = h.deps.instagram!.enqueueAccountPhoto;
    h.deps.instagram!.enqueueAccountPhoto = async () => {
      throw new Error("queue down");
    };
    try {
      const r = await (await h.signIn(admin)).inject({ method: "GET", url: "/api/v1/instagram/accounts" });
      expect(r.statusCode).toBe(200);
      await new Promise((res) => setTimeout(res, 20));
    } finally {
      h.deps.instagram!.enqueueAccountPhoto = real;
    }
    await list();
    expect(h.instagramAccountPhotoQueued).toEqual([account.id]);
  });

  it("an account that needs connecting again isn't asked for", async () => {
    await h.ownerPool.query("UPDATE instagram_accounts SET status = 'needs_attention' WHERE id = $1", [
      account.id,
    ]);
    await list();
    expect(h.instagramAccountPhotoQueued).toHaveLength(0);
  });

  it("bytes that aren't a photo, or a link off Meta's hosts: the photo as it was", async () => {
    await list();
    await h.runInstagramAccountPhoto();
    const kept = (await row()).photo_sha256;
    for (const url of [
      pic("page.jpg", "image/jpeg", Buffer.from("<html>not a photo</html>")),
      "https://photos.example.test/me.jpg",
    ]) {
      h.clock.advance(8 * DAY);
      hasPic(url);
      await list();
      await h.runInstagramAccountPhoto();
      expect((await row()).photo_sha256).toBe(kept);
    }
  });

  it("Meta down: tried again later, nothing marked", async () => {
    await list();
    ig.failPaths.add("/cdn/me.jpg");
    await h.runInstagramAccountPhoto();
    expect((await row()).photo_checked_at).toBeNull();
    expect(h.instagramAccountPhotoQueued).toEqual([account.id]);
    ig.failPaths.clear();
    await h.runInstagramAccountPhoto();
    expect((await row()).photo_sha256).not.toBeNull();
  });

  it("an account that isn't active (needs connecting again): nothing fetched", async () => {
    await list();
    await h.ownerPool.query("UPDATE instagram_accounts SET status = 'needs_attention' WHERE id = $1", [
      account.id,
    ]);
    await h.runInstagramAccountPhoto();
    expect(cdnCalls()).toBe(0);
    expect((await row()).photo_checked_at).toBeNull();
  });

  it("disconnected: its photo goes with it, and the file is no longer counted", async () => {
    await list();
    await h.runInstagramAccountPhoto();
    const sha = (await row()).photo_sha256!;
    await h.ownerPool.query(
      "UPDATE instagram_accounts SET status = 'disconnected', token_enc = NULL WHERE id = $1",
      [account.id],
    );
    expect((await row()).photo_sha256).toBeNull();
    expect(await refs(sha)).toBe(0);
  });

  it("only those who manage integrations see it; an account with no photo is a 204 (initials)", async () => {
    await list();
    const url = `/api/v1/instagram/accounts/${account.id}/photo`;
    expect((await (await h.signIn(admin)).inject({ method: "GET", url })).statusCode).toBe(204);
    await h.runInstagramAccountPhoto();
    expect((await (await h.signIn(rep)).inject({ method: "GET", url })).statusCode).toBe(403);
    expect((await (await h.signIn(admin)).inject({ method: "GET", url })).statusCode).toBe(200);
  });
});
