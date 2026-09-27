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
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
});
