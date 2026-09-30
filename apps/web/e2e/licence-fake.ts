// The fake licence server for e2e (licensing L-A): answers /v1/check with a token signed by a key made at
// start, whose public half it writes where api-server.mjs reads it (LUME_LICENSE_EXTRA_KEYS: a development
// build only). A test says what the licence is with POST /__fake/state. Nothing ever calls the real one.
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { rawPublicKey, signLicence, type LicenceNotice, type LicenceStateName } from "@lume/core";

export const E2E_INSTANCE = "LUME-E2E-0001";
export const E2E_KEY = "LUME-E2E-KEY-0001";

type Says = {
  state: LicenceStateName;
  reason: string;
  licenseType: "subscription" | "perpetual" | "trial";
  paidUntil: string | null;
  notice: LicenceNotice | null;
  /** Refuse checks as if unreachable (the API keeps its last token). */
  down: boolean;
};
const ACTIVE: Says = {
  state: "active",
  reason: "paid",
  licenseType: "subscription",
  paidUntil: "2099-12-31",
  notice: null,
  down: false,
};

const here = import.meta.dirname;
const dir = here.endsWith(".artifacts") ? here : path.join(here, ".artifacts");
const keys = generateKeyPairSync("ed25519");
let says: Says = { ...ACTIVE };
let checks = 0;

const body = (req: import("node:http").IncomingMessage) =>
  new Promise<string>((done) => {
    let s = "";
    req.on("data", (c: Buffer) => (s += c.toString("utf8")));
    req.on("end", () => done(s));
  });
const send = (res: import("node:http").ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "POST" && req.url === "/v1/check") {
      const b = JSON.parse(await body(req)) as { instanceId?: string; licenseKey?: string };
      checks++;
      if (says.down) return send(res, 503, { error: { code: "DOWN" } });
      if (b.instanceId !== E2E_INSTANCE || b.licenseKey !== E2E_KEY)
        return send(res, 401, { error: { code: "UNKNOWN_KEY" } });
      const now = Date.now();
      return send(res, 200, {
        token: signLicence(
          {
            v: 1,
            kid: "e2e",
            instanceId: E2E_INSTANCE,
            state: says.state,
            licenseType: says.licenseType,
            issuedAt: new Date(now).toISOString(),
            validUntil: new Date(now + 8 * 86_400_000).toISOString(),
            paidUntil: says.paidUntil,
            trialEndsAt: null,
            reason: says.reason,
            notice: says.notice,
          },
          keys.privateKey,
        ),
      });
    }
    if (req.url === "/__fake/state" && req.method === "POST") {
      says = { ...ACTIVE, ...(JSON.parse(await body(req)) as Partial<Says>) };
      return send(res, 200, { says });
    }
    if (req.url === "/__fake/state") return send(res, 200, { says, checks });
    send(res, 404, {});
  })();
});
const port = Number(process.env.E2E_LICENCE_PORT ?? 3113);
server.listen(port, "127.0.0.1", () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "licence-key.txt"), `e2e:${rawPublicKey(keys.publicKey)}`);
  console.log(`licence fake on http://127.0.0.1:${port}`);
});
