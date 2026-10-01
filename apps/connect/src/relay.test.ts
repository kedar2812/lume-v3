import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceIdOf, sign, unseal, verify, type Handoff } from "@lume/core";
import { startGoogleFake, type GoogleFake } from "../../api/test/google-fake";
import { createRelay } from "./relay";

const TOKEN = "i".repeat(40);
let fake: GoogleFake;
let base: string;
let server: http.Server;
const get = (path: string) => fetch(`${base}${path}`, { redirect: "manual" });

beforeAll(async () => {
  fake = await startGoogleFake();
  server = http.createServer(
    createRelay({
      publicUrl: "http://relay.test",
      clientId: "cid",
      clientSecret: "csecret",
      pickerKey: "pkey",
      appId: "123",
      secret: "s".repeat(40),
      instances: [{ url: "https://client-a.example", token: TOKEN }],
      googleAuthUrl: "https://accounts.google.test/o/oauth2/v2/auth",
      googleTokenUrl: `${fake.url}/token`,
      googleApiUrl: fake.url,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.put("sheet-1-abcdefghij", { title: "Leads", tabs: [], sharedWith: [] });
  fake.putFile("doc-1-abcdefghij", "application/vnd.google-apps.document");
});
afterAll(async () => {
  server.close();
  await fake.close();
});

describe("the relay", () => {
  it("Review Focus 2: start refuses an unknown instance or a bad signature, and never redirects elsewhere", async () => {
    expect((await get(`/start?i=ffffffffffffffff&n=abc&s=${sign(TOKEN, "abc")}`)).status).toBe(400);
    expect((await get(`/start?i=${instanceIdOf(TOKEN)}&n=abc&s=wrong`)).status).toBe(400);
  });

  it("start sends the browser to Google asking only for drive.file, with a state only the relay can make", async () => {
    const r = await get(`/start?i=${instanceIdOf(TOKEN)}&n=abc&s=${sign(TOKEN, "abc")}`);
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.test/o/oauth2/v2/auth");
    expect(to.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(to.searchParams.get("access_type")).toBe("offline");
    expect(to.searchParams.get("redirect_uri")).toBe("http://relay.test/callback");
    expect(to.searchParams.get("state")).toBeTruthy();
  });

  it("callback exchanges the code and shows the Picker; done hands back a sealed grant to that instance only", async () => {
    const start = await get(`/start?i=${instanceIdOf(TOKEN)}&n=nonce-9&s=${sign(TOKEN, "nonce-9")}`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const page = await get(`/callback?code=good-code&state=${encodeURIComponent(state)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("https://apis.google.com/js/api.js");
    expect(html).toContain('"pkey"');
    const codeToken = /name="code_token" value="([^"]+)"/.exec(html)![1]!;
    const done = await fetch(`${base}/done`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        state,
        code_token: codeToken,
        file_id: "sheet-1-abcdefghij",
        file_name: "Leads",
      }),
    });
    expect(done.status).toBe(302);
    const back = new URL(done.headers.get("location")!);
    expect(back.origin + back.pathname).toBe("https://client-a.example/settings/integrations/connected");
    const p = back.searchParams.get("p")!;
    expect(verify(TOKEN, p, back.searchParams.get("s")!)).toBe(true);
    const h = unseal<Handoff>(TOKEN, p)!;
    expect(h).toMatchObject({
      nonce: "nonce-9",
      refreshToken: "rt-good",
      file: { id: "sheet-1-abcdefghij", name: "Leads" },
    });
  });

  it("a bad code or a tampered state gets a plain error page, not a redirect", async () => {
    const start = await get(`/start?i=${instanceIdOf(TOKEN)}&n=n2&s=${sign(TOKEN, "n2")}`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    expect((await get(`/callback?code=bad&state=${encodeURIComponent(state)}`)).status).toBe(400);
    expect((await get(`/callback?code=good-code&state=${encodeURIComponent(state + "x")}`)).status).toBe(400);
  });

  it("refresh gives a new access token to the instance that owns the grant, and refuses strangers", async () => {
    const ok = await fetch(`${base}/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "rt-good" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ accessToken: expect.any(String), expiresIn: 3600 });
    const stranger = await fetch(`${base}/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${"z".repeat(40)}`, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "rt-good" }),
    });
    expect(stranger.status).toBe(401);
    fake.revokeGrant();
    const revoked = await fetch(`${base}/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "rt-good" }),
    });
    expect(revoked.status).toBe(400);
    expect(((await revoked.json()) as { error: string }).error).toBe("revoked");
    fake.restoreGrant();
  });

  /** Start → callback: the Picker page's state and code token. */
  async function toPicker(at = base, n = "n-" + Math.random().toString(36).slice(2)) {
    const start = await fetch(`${at}/start?i=${instanceIdOf(TOKEN)}&n=${n}&s=${sign(TOKEN, n)}`, {
      redirect: "manual",
    });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const page = await fetch(`${at}/callback?code=good-code&state=${encodeURIComponent(state)}`);
    const html = await page.text();
    return { state, page, html, codeToken: /name="code_token" value="([^"]+)"/.exec(html)?.[1] ?? "" };
  }
  const done = (state: string, codeToken: string, fileId: string, at = base) =>
    fetch(`${at}/done`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state, code_token: codeToken, file_id: fileId, file_name: "Leads" }),
    });

  it("a code token works once: a second /done with it is refused", async () => {
    const p = await toPicker();
    expect((await done(p.state, p.codeToken, "sheet-1-abcdefghij")).status).toBe(302);
    expect((await done(p.state, p.codeToken, "sheet-1-abcdefghij")).status).toBe(400);
  });

  it("a file that isn't a spreadsheet is refused, in words", async () => {
    const p = await toPicker();
    const r = await done(p.state, p.codeToken, "doc-1-abcdefghij");
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/isn't a Google Sheet/);
  });

  it("its pages can't be framed; the Picker sends only the relay's origin (its key is restricted to it)", async () => {
    const p = await toPicker();
    expect(p.page.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    // The Picker key is limited to https://connect.lumecrm.in by referrer: no-referrer would break it.
    expect(p.page.headers.get("referrer-policy")).toBe("strict-origin");
    const words = await get(`/callback?error=access_denied&state=${encodeURIComponent(p.state)}`);
    expect(words.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("a sheet in a shared drive is a sheet; a file LUME can't see says so, not that it isn't one", async () => {
    fake.put("shared-1-abcdefghij", { title: "Team leads", tabs: [], sharedWith: [] });
    fake.inSharedDrive("shared-1-abcdefghij");
    const p = await toPicker();
    expect((await done(p.state, p.codeToken, "shared-1-abcdefghij")).status).toBe(302);
    const q = await toPicker();
    const r = await done(q.state, q.codeToken, "nowhere-1-abcdefghij");
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/couldn't see that file/);
  });

  it("the Picker page names its function so it doesn't shadow window.open", async () => {
    const p = await toPicker();
    expect(p.html).not.toMatch(/function open\(/);
    expect(p.html).toMatch(/gapi\.load\('picker', openPicker\)/);
  });

  it("a cancelled Picker offers Pick again and a way back to LUME", async () => {
    const p = await toPicker();
    expect(p.html).toContain("Pick again");
    expect(p.html).toContain('href="https://client-a.example/settings/integrations"');
  });

  it("consent turned down says so (not “expired”), with a way back to LUME", async () => {
    const start = await get(`/start?i=${instanceIdOf(TOKEN)}&n=n-deny&s=${sign(TOKEN, "n-deny")}`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const r = await get(`/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toMatch(/didn't give LUME access/);
    expect(html).not.toMatch(/expired/);
    expect(html).toContain('href="https://client-a.example/settings/integrations"');
  });

  it("an expired state at the callback is refused; old code tokens are swept from memory", async () => {
    let t = Date.now();
    const clocked = http.createServer(
      createRelay({
        publicUrl: "http://relay.test",
        clientId: "cid",
        clientSecret: "csecret",
        pickerKey: "pkey",
        appId: "123",
        secret: "s".repeat(40),
        instances: [{ url: "https://client-a.example", token: TOKEN }],
        googleAuthUrl: "https://accounts.google.test/o/oauth2/v2/auth",
        googleTokenUrl: `${fake.url}/token`,
        googleApiUrl: fake.url,
        now: () => t,
      }),
    );
    await new Promise<void>((r) => clocked.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(clocked.address() as AddressInfo).port}`;
    try {
      const relay = clocked.listeners("request")[0] as ReturnType<typeof createRelay>;
      await toPicker(at);
      await toPicker(at);
      expect(relay.pendingSize()).toBe(2);
      const start = await fetch(`${at}/start?i=${instanceIdOf(TOKEN)}&n=n-old&s=${sign(TOKEN, "n-old")}`, {
        redirect: "manual",
      });
      const oldState = new URL(start.headers.get("location")!).searchParams.get("state")!;
      t += 11 * 60_000;
      expect(
        (await fetch(`${at}/callback?code=good-code&state=${encodeURIComponent(oldState)}`)).status,
      ).toBe(400);
      await toPicker(at);
      expect(relay.pendingSize()).toBe(1);
    } finally {
      clocked.close();
    }
  });

  describe("a calendar (Phase 5A)", () => {
    const calStart = (n: string, k = "calendar", sig = sign(TOKEN, `${n}.calendar`)) =>
      get(`/start?i=${instanceIdOf(TOKEN)}&n=${n}&k=${k}&s=${sig}`);

    it("asks Google for read-only calendar access and nothing else", async () => {
      const r = await calStart("cal-1");
      expect(r.status).toBe(302);
      const scopes = new URL(r.headers.get("location")!).searchParams.get("scope")!.split(" ").sort();
      expect(scopes).toEqual([
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
      ]);
    });

    it("a sheet link can't be turned into a calendar one: the kind is signed", async () => {
      expect((await calStart("cal-2", "calendar", sign(TOKEN, "cal-2"))).status).toBe(400);
    });

    it("back from Google, the grant goes straight to the instance's calendar page — no Picker", async () => {
      const start = await calStart("cal-3");
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const r = await get(`/callback?code=good-code&state=${encodeURIComponent(state)}`);
      expect(r.status).toBe(302);
      const back = new URL(r.headers.get("location")!);
      expect(back.origin + back.pathname).toBe("https://client-a.example/calendar/connected");
      const p = back.searchParams.get("p")!;
      expect(verify(TOKEN, p, back.searchParams.get("s")!)).toBe(true);
      expect(unseal<Handoff>(TOKEN, p)).toMatchObject({ nonce: "cal-3", refreshToken: "rt-good", kind: "calendar" });
    });
  });
});
