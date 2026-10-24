import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { instanceIdOf, relayCheck, sign, unseal, verify, type Handoff } from "@lume/core";
import { inbound } from "../../../packages/core/src/whatsapp/fixtures";
import { startMetaFake, type MetaFake } from "../../api/test/meta-fake";
import { createRelay, type RelayConfig } from "./relay";

/** WhatsApp through the relay (spec 2026-10-18 §3.2–3.3; plan W1 Task 2). */
const TOKEN = "i".repeat(40);
const ID = instanceIdOf(TOKEN);
let meta: MetaFake;
let relay: http.Server;
let bare: http.Server;
let base: string;
let bareBase: string;
// The client's LUME, as the relay sees it: what was forwarded, and how it answers.
let instance: http.Server;
let forwarded: { headers: http.IncomingHttpHeaders; raw: Buffer }[] = [];
let instanceStatus = 200;

const config = (o: Partial<RelayConfig> = {}): RelayConfig => ({
  publicUrl: "http://relay.test",
  clientId: "cid",
  clientSecret: "csecret",
  pickerKey: "pkey",
  appId: "123",
  secret: "s".repeat(40),
  instances: [{ url: instanceUrl(), token: TOKEN }],
  ...o,
});
let instancePort = 0;
const instanceUrl = () => `http://127.0.0.1:${instancePort}`;
const listen = async (s: http.Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  meta = await startMetaFake();
  instance = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      forwarded.push({ headers: req.headers, raw: Buffer.concat(chunks) });
      res.writeHead(instanceStatus);
      res.end();
    });
  });
  await listen(instance);
  instancePort = (instance.address() as AddressInfo).port;
  relay = http.createServer(
    createRelay(
      config({
        meta: {
          appId: meta.appId,
          appSecret: meta.appSecret,
          configId: meta.configId,
          verifyToken: meta.verifyToken,
          graphUrl: meta.url,
          version: meta.version,
        },
      }),
    ),
  );
  base = await listen(relay);
  bare = http.createServer(createRelay(config()));
  bareBase = await listen(bare);
});
afterAll(async () => {
  relay.close();
  bare.close();
  instance.close();
  await meta.close();
});
beforeEach(() => {
  forwarded = [];
  instanceStatus = 200;
  meta.calls.length = 0;
  meta.failHistorySync = false;
});

const startLink = (n = "nonce-1") => `${base}/wa/start?i=${ID}&n=${n}&s=${sign(TOKEN, `${n}.whatsapp`)}`;
async function stateFrom(n = "nonce-1") {
  const html = await (await fetch(startLink(n))).text();
  return /name="state" value="([^"]+)"/.exec(html)![1]!;
}
const done = (fields: Record<string, string>) =>
  fetch(`${base}/wa/done`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

describe("connecting a WhatsApp number (Embedded Signup)", () => {
  it("start refuses a bad signature, and one signed for a sheet", async () => {
    expect((await fetch(`${base}/wa/start?i=${ID}&n=x&s=wrong`)).status).toBe(400);
    expect((await fetch(`${base}/wa/start?i=${ID}&n=x&s=${sign(TOKEN, "x")}`)).status).toBe(400);
  });

  it("start serves Meta's signup with LUME's configuration, and never the app secret", async () => {
    const r = await fetch(startLink());
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("https://connect.facebook.net/en_US/sdk.js");
    expect(html).toContain(meta.configId);
    expect(html).toContain("whatsapp_business_app_onboarding");
    expect(html).not.toContain(meta.appSecret);
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("done: the code exchanged, the account subscribed with this LUME's own callback, both syncs asked, the number handed back sealed", async () => {
    const r = await done({
      state: await stateFrom(),
      code: "good-code",
      waba_id: "102290129340398",
      phone_number_id: "106540352242922",
    });
    expect(r.status).toBe(302);
    const back = new URL(r.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(`${instanceUrl()}/settings/integrations/whatsapp/connected`);
    const p = back.searchParams.get("p")!;
    expect(verify(TOKEN, p, back.searchParams.get("s")!)).toBe(true);
    expect(unseal<Handoff>(TOKEN, p)).toMatchObject({
      kind: "whatsapp",
      nonce: "nonce-1",
      whatsapp: {
        token: "EAAG-business-token",
        wabaId: "102290129340398",
        phoneNumberId: "106540352242922",
        display: "+91 90000 00001",
        name: "Harbour Studio",
        history: true,
      },
    });
    const sub = meta.calls.find((c) => c.path.endsWith("/102290129340398/subscribed_apps"))!;
    expect(sub.body).toEqual({
      override_callback_uri: `http://relay.test/wa/in/${ID}`,
      verify_token: meta.verifyToken,
    });
    const syncs = meta.calls
      .filter((c) => c.path.endsWith("/smb_app_data"))
      .map((c) => (c.body as { sync_type: string }).sync_type);
    expect(syncs).toEqual(["smb_app_state_sync", "history"]);
  });

  it("a history sync Meta refuses still connects, and says so", async () => {
    meta.failHistorySync = true;
    const r = await done({
      state: await stateFrom("n2"),
      code: "good-code",
      waba_id: "102290129340398",
      phone_number_id: "106540352242922",
    });
    const p = new URL(r.headers.get("location")!).searchParams.get("p")!;
    expect(unseal<Handoff>(TOKEN, p)?.whatsapp?.history).toBe(false);
  });

  it("a code Meta refuses is said in words, with a way back to LUME", async () => {
    const r = await done({
      state: await stateFrom("n3"),
      code: "bad-code",
      waba_id: "102290129340398",
      phone_number_id: "106540352242922",
    });
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain("Back to LUME");
    expect(html).not.toContain("OAuthException");
  });

  it("done refuses a forged state, and ids that aren't Meta's", async () => {
    expect(
      (await done({ state: "x.y", code: "good-code", waba_id: "102290129340398", phone_number_id: "2" }))
        .status,
    ).toBe(400);
    const s = await stateFrom("n4");
    expect((await done({ state: s, code: "good-code", waba_id: "../x", phone_number_id: "2" })).status).toBe(
      400,
    );
  });
});

describe("Meta's deliveries", () => {
  it("the verify handshake: the right token gets the challenge back, a wrong one doesn't", async () => {
    const q = (t: string) =>
      `${base}/wa/in/${ID}?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=12345`;
    const ok = await fetch(q(meta.verifyToken));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    expect((await fetch(q("wrong"))).status).toBe(403);
  });

  it("forwarded byte for byte, signed with this instance's token; Meta hears 200", async () => {
    const r = await meta.deliver(`${base}/wa/in/${ID}`, inbound());
    expect(r.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    const f = forwarded[0]!;
    expect(f.raw.toString()).toBe(JSON.stringify(inbound()));
    expect(
      relayCheck(
        TOKEN,
        f.headers["x-lume-timestamp"] as string,
        f.headers["x-lume-signature"] as string,
        f.raw,
        Date.now(),
      ),
    ).toBe("ok");
  });

  it("not signed by Meta: 401, nothing forwarded; an unknown instance: 404", async () => {
    const bad = await fetch(`${base}/wa/in/${ID}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" },
      body: "{}",
    });
    expect(bad.status).toBe(401);
    expect((await meta.deliver(`${base}/wa/in/ffffffffffffffff`, inbound())).status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  it("Review Focus 3: when the client's LUME can't take it, Meta hears 503 and tries again later", async () => {
    instanceStatus = 500;
    expect((await meta.deliver(`${base}/wa/in/${ID}`, inbound())).status).toBe(503);
  });

  it("a body over 3 MB is refused", async () => {
    expect((await meta.deliver(`${base}/wa/in/${ID}`, { pad: "x".repeat(3 * 1024 * 1024) })).status).toBe(
      413,
    );
  });

  it("a relay without Meta's settings has no WhatsApp routes, and Google's still work", async () => {
    expect((await fetch(`${bareBase}/wa/start?i=${ID}&n=x&s=${sign(TOKEN, "x.whatsapp")}`)).status).toBe(404);
    expect((await fetch(`${bareBase}/healthz`)).status).toBe(200);
  });
});

/** Meta's WhatsApp tokens last 60 days (LUME's Embedded Signup configuration): the relay refreshes them, as it holds the app secret. */
describe("refreshing a number's token", () => {
  const refresh = (token: string, bearer = TOKEN) =>
    fetch(`${base}/wa/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });

  it("asks Meta for a fresh 60-day token with the app secret, and hands it back", async () => {
    const r = await refresh("EAAG-business-token");
    expect(r.status).toBe(200);
    const b = (await r.json()) as { token: string; expiresIn: number };
    expect(b.token).toMatch(/^EAAG-business-token\.r\d+$/);
    expect(b.expiresIn).toBe(60 * 86_400);
    // The fake answers only fb_exchange_token with LUME's app id and secret and the 60-day flag, as Meta's docs say.
    expect(meta.calls.some((c) => c.path === `/${meta.version}/oauth/access_token`)).toBe(true);
    // The new token works with Meta from now on.
    expect([...meta.codes.values()]).toContain(b.token);
    expect(JSON.stringify(b)).not.toContain(meta.appSecret);
  });

  it("a token Meta no longer accepts: 400 revoked", async () => {
    meta.revoked.add("EAAG-business-token");
    try {
      const r = await refresh("EAAG-business-token");
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "revoked" });
    } finally {
      meta.revoked.delete("EAAG-business-token");
    }
  });

  it("only a known LUME may ask, with a token; a relay without Meta's settings has no such route", async () => {
    expect((await refresh("EAAG-business-token", "x".repeat(40))).status).toBe(401);
    expect((await refresh("")).status).toBe(400);
    expect(
      (
        await fetch(`${bareBase}/wa/refresh`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
          body: "{}",
        })
      ).status,
    ).toBe(404);
  });
});
