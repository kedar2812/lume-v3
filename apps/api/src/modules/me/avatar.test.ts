import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** A minimal lossy WebP header of the given size: enough for LUME's checks, which never decode. */
const webp = (w = 256, h = 256, extra: number[] = []) => {
  const payload = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, w & 255, w >> 8, h & 255, h >> 8, 1, 2, 3, 4];
  const body = [...ascii("WEBP"), ...ascii("VP8 "), ...le32(payload.length), ...payload, ...extra];
  return Buffer.from([...ascii("RIFF"), ...le32(body.length), ...body]).toString("base64");
};

describe("profile photo (7C)", () => {
  it("keeps a colour and a checked photo, serves it to colleagues by version, and removes it", async () => {
    const me = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
    const colleague = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const c = await h.signIn(me);

    const color = await c.inject({ method: "PUT", url: "/api/v1/me/avatar", payload: { color: "teal" } });
    expect(color.statusCode).toBe(200);
    expect(color.json().avatar).toEqual({ color: "teal", version: 1, photo: false });

    const put = await c.inject({ method: "PUT", url: "/api/v1/me/avatar", payload: { image: webp() } });
    expect(put.json().avatar).toEqual({ color: "teal", version: 2, photo: true });

    const people = (await c.inject({ method: "GET", url: "/api/v1/people" })).json().people;
    expect(people.find((p: { id: string }) => p.id === me.id).avatar).toEqual({
      color: "teal",
      version: 2,
      photo: true,
    });
    const self = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json().user;
    expect(self.avatar).toEqual({ color: "teal", version: 2, photo: true });

    const other = await h.signIn(colleague);
    const img = await other.inject({ method: "GET", url: `/api/v1/users/${me.id}/avatar?v=2` });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/webp");
    expect(img.headers["cache-control"]).toContain("immutable");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    expect(img.rawPayload.subarray(0, 4).toString()).toBe("RIFF");

    const gone = await c.inject({ method: "DELETE", url: "/api/v1/me/avatar" });
    expect(gone.json().avatar).toEqual({ color: "teal", version: 3, photo: false });
    expect((await other.inject({ method: "GET", url: `/api/v1/users/${me.id}/avatar?v=3` })).statusCode).toBe(
      404,
    );
    const audit = await h.pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.avatar.updated' AND entity_id = $1",
      [me.id],
    );
    expect(audit.rows[0].n).toBe(3);
  });

  it("refuses a photo that isn't exactly a 256 px square with nothing else in it, in words", async () => {
    const me = await h.seedUser({ grants: [] });
    const c = await h.signIn(me);
    for (const image of [
      webp(4096, 4096), // the bomb guard: a size read from the header, before anything decodes
      webp(256, 256, [...ascii("EXIF"), ...le32(4), 1, 2, 3, 4]), // where it was taken, and with what
      Buffer.from("<svg onload=alert(1)>").toString("base64"),
    ]) {
      const r = await c.inject({ method: "PUT", url: "/api/v1/me/avatar", payload: { image } });
      expect(r.statusCode).toBe(422);
      expect(r.json().error).toMatchObject({ code: "AVATAR_REFUSED" });
      expect(r.json().error.message).toMatch(/^LUME keeps a 256 × 256 photo/);
    }
    const huge = await c.inject({
      method: "PUT",
      url: "/api/v1/me/avatar",
      payload: { image: "A".repeat(300_000) },
    });
    expect(huge.statusCode).toBeGreaterThanOrEqual(400);
    const color = await c.inject({ method: "PUT", url: "/api/v1/me/avatar", payload: { color: "violet" } });
    expect(color.statusCode).toBe(400);
    expect((await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json().user.avatar).toEqual({
      color: null,
      version: 0,
      photo: false,
    });
  });

  it("is your own: no one changes another person's look, and a photo needs a signed-in viewer", async () => {
    const me = await h.seedUser({ grants: [] });
    const c = await h.signIn(me);
    await c.inject({ method: "PUT", url: "/api/v1/me/avatar", payload: { image: webp() } });
    const anon = await h.app.inject({ method: "GET", url: `/api/v1/users/${me.id}/avatar?v=1` });
    expect(anon.statusCode).toBe(401);
    const sneaky = await c.inject({
      method: "PUT",
      url: "/api/v1/me/avatar",
      payload: { image: webp(), userId: "00000000-0000-7000-8000-000000000999" },
    });
    expect(sneaky.statusCode).toBe(400); // the body takes only colour and image
  });
});
