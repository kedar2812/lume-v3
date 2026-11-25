// The real connect relay for e2e (WhatsApp, plan W1 Task 11), with Meta pointed at the fake: Embedded Signup's
// hand-back and Meta's deliveries run through the same code a client's server meets. Google isn't used here.
// Instagram (plan 2026-11-25-instagram-screens D1): the relay's own sign-in, against a fake Instagram in this process.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRelay } from "../../connect/src/relay";
import { createRouteStore } from "../../connect/src/routes-store";

export const E2E_RELAY_TOKEN = "e2e-relay-token-0123456789-abcdefghij";
const port = Number(process.env.E2E_RELAY_PORT ?? 3115);
const edge = Number(process.env.E2E_EDGE_PORT ?? 3100);
const igPort = Number(process.env.E2E_IG_PORT ?? 3117);
const meta = `http://127.0.0.1:${process.env.E2E_META_PORT ?? 3114}`;
const ig = `http://127.0.0.1:${igPort}`;
const relayUrl = `http://127.0.0.1:${port}`;

/**
 * The fake Instagram: its sign-in page says yes at once (or what a test set with POST /__fake/ig), then its token
 * exchange, the 60-day token, the account and its subscription answer as Instagram's API does. No test calls Instagram.
 */
type IgMode = { username: string; userId: string; accountType: string; cancel: boolean };
const IG_DEFAULT: IgMode = {
  username: "harbour.studio",
  userId: "17841400000000001",
  accountType: "BUSINESS",
  cancel: false,
};
let mode: IgMode = { ...IG_DEFAULT };
/** People who write in tests, by their Instagram id: their name and handle as Instagram answers them. */
const people = new Map<string, { name: string; username: string }>();
let sent = 0;
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
http
  .createServer((req, res) => {
    const u = new URL(req.url ?? "/", ig);
    if (u.pathname === "/healthz") return json(res, 200, { ok: true });
    if (u.pathname === "/__fake/ig" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        mode = { ...IG_DEFAULT, ...(raw ? (JSON.parse(raw) as Partial<IgMode>) : {}) };
        json(res, 200, mode);
      });
      return;
    }
    if (u.pathname === "/__fake/ig/person" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const p = JSON.parse(raw) as { id: string; name: string; username: string };
        people.set(p.id, { name: p.name, username: p.username });
        json(res, 200, { ok: true });
      });
      return;
    }
    if (u.pathname === "/oauth/authorize") {
      const back = new URL(u.searchParams.get("redirect_uri") ?? `${relayUrl}/ig/callback`);
      back.searchParams.set("state", u.searchParams.get("state") ?? "");
      if (mode.cancel) back.searchParams.set("error", "access_denied");
      else back.searchParams.set("code", "ig-good-code");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (u.pathname === "/oauth/access_token" && req.method === "POST")
      return json(res, 200, {
        data: [
          {
            access_token: "ig-short-token",
            user_id: mode.userId,
            permissions:
              "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments",
          },
        ],
      });
    if (u.pathname === "/access_token")
      return json(res, 200, {
        access_token: `ig-long-${mode.userId}`,
        token_type: "bearer",
        expires_in: 5_184_000,
      });
    if (/^\/v[\d.]+\/me$/.test(u.pathname))
      return json(res, 200, {
        user_id: mode.userId,
        username: mode.username,
        name: "Harbour Studio",
        account_type: mode.accountType,
      });
    if (/^\/v[\d.]+\/\d+\/subscribed_apps$/.test(u.pathname)) return json(res, 200, { success: true });
    // A reply from LUME: taken, as Instagram's API answers it.
    if (/^\/v[\d.]+\/\d+\/messages$/.test(u.pathname) && req.method === "POST") {
      req.resume();
      sent += 1;
      return json(res, 200, { recipient_id: "6512000000000001", message_id: `aWdfE2E${sent}` });
    }
    // A person's name and handle, and no photo (LUME shows initials).
    const who = /^\/v[\d.]+\/(\d+)$/.exec(u.pathname);
    if (who && req.method === "GET") {
      const p = people.get(who[1]!);
      if (u.searchParams.get("fields")?.includes("profile_pic")) return json(res, 200, { id: who[1] });
      return json(res, 200, {
        id: who[1],
        name: p?.name ?? "Someone",
        username: p?.username ?? `user${who[1]!.slice(-4)}`,
      });
    }
    // Catching up after connecting: nothing waiting.
    if (/^\/v[\d.]+\/\d+\/conversations$/.test(u.pathname)) return json(res, 200, { data: [] });
    json(res, 404, { error: { message: "Unknown path for the fake Instagram", code: 100 } });
  })
  .listen(igPort, "127.0.0.1", () => console.log(`instagram fake on ${igPort}`));

http
  .createServer(
    createRelay({
      publicUrl: relayUrl,
      clientId: "e2e-client",
      clientSecret: "e2e-client-secret",
      pickerKey: "e2e-picker",
      appId: "1",
      secret: "e2e-relay-secret-0123456789-abcdefghij",
      instances: [{ url: `http://127.0.0.1:${edge}`, token: E2E_RELAY_TOKEN }],
      meta: {
        appId: "1234567890",
        appSecret: "meta-app-secret-for-tests",
        configId: "987654321",
        verifyToken: "verify-token-for-tests",
        graphUrl: meta,
        version: "v23.0",
      },
      instagram: {
        appId: "2468013579",
        appSecret: "ig-app-secret-for-tests",
        verifyToken: "ig-verify-token-for-tests",
        oauthUrl: `${ig}/oauth/authorize`,
        tokenUrl: `${ig}/oauth/access_token`,
        graphUrl: ig,
        version: "v27.0",
      },
      instagramRoutes: createRouteStore(path.join(os.tmpdir(), `lume-e2e-ig-routes-${process.pid}.json`)),
    }),
  )
  .listen(port, "127.0.0.1", () => console.log(`relay on ${port}`));
