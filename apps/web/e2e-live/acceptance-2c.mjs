// Phase 2C live acceptance: webhooks on the running dev stack, through Caddy's TLS, as the owner — spec
// 2026-09-28-phase-2c §1: set one up with a test post, a signed post becomes a lead, a forged one doesn't.
// Screenshots go to docs/runbooks/screenshots-2c. Runs after acceptance-1c1.mjs in the same throwaway
// container, with the sessions handed over in ACCEPT_STATE_DIR. Needs nothing from outside (no accounts).
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const STATE = process.env.ACCEPT_STATE_DIR;
if (!STATE) throw new Error("ACCEPT_STATE_DIR is required (run acceptance-1c1.mjs first)");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-2c");
mkdirSync(SHOTS, { recursive: true });

const ok = (msg) => console.log(`ok   ${msg}`);
function assert(cond, msg, detail) {
  if (!cond) {
    console.error(`FAIL ${msg}${detail === undefined ? "" : `\n     ${JSON.stringify(detail)}`}`);
    process.exit(1);
  }
  ok(msg);
}

const browser = await chromium.launch();
const signedIn = async (who, theme = "porcelain") => {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1366, height: 800 },
    reducedMotion: "no-preference",
    storageState: path.join(STATE, `${who}.json`),
  });
  await ctx.addCookies([{ name: "lume_theme", value: theme, url: BASE }]);
  const page = await ctx.newPage();
  const goto = page.goto.bind(page);
  page.goto = async (url) => {
    const r = await goto(url.startsWith("http") ? url : `${BASE}${url}`);
    await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    return r;
  };
  return page;
};
const shot = async (page, name, mask = []) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), mask });
};
const api = (page, method, url, body) =>
  page.evaluate(
    async ({ method, url, body }) => {
      const { token } = await (await fetch("/api/v1/auth/csrf")).json();
      const res = await fetch(url, {
        method,
        headers: {
          "x-csrf-token": token,
          ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, data: text ? JSON.parse(text) : null };
    },
    { method, url, body },
  );
/** A post from outside, as a website's server would send it: through the edge, signed. */
async function send(address, secret, body) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `sha256=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`;
  const res = await fetch(address.replace(/^https?:\/\/[^/]+/, BASE), {
    method: "POST",
    headers: { "content-type": "application/json", "x-lume-timestamp": ts, "x-lume-signature": sig },
    body: raw,
  });
  return res.status;
}
const until = async (page, what, check) => {
  for (let i = 0; i < 30; i++) {
    const v = await check();
    if (v) return v;
    await page.waitForTimeout(1000);
  }
  assert(false, what);
};

const owner = await signedIn("owner");

// 1 ─ Settings → Integrations: Webhooks off by default, then on ────────────────────────────────────
await owner.goto("/settings/integrations");
await owner.locator("#settings-title", { hasText: "Integrations" }).waitFor();
const before = (await api(owner, "GET", "/api/v1/integrations")).data;
assert(before.webhooks.enabled === false, "Webhooks are off until someone switches them on");
assert(before.webhooks.manychat === false, "ManyChat isn't offered (not verified yet)");
await owner.getByRole("switch", { name: "Webhooks" }).click();
await owner.getByRole("button", { name: "Add a webhook" }).waitFor();
ok("switched on");

// 2 ─ Add one: the address and secret once, a test post, the usual steps ─────────────────────────
await owner.getByRole("button", { name: "Add a webhook" }).click();
const dialog = owner.getByRole("dialog", { name: "Add a webhook" });
await dialog.getByRole("radio", { name: /Website form/ }).check();
await dialog.getByLabel("Name").fill("Acceptance form");
await shot(owner, "01-where-from");
await dialog.getByRole("button", { name: "Create webhook" }).click();
await dialog.getByText("LUME won't show this again. Copy it now.").waitFor();
const [address, secret] = await dialog.locator("code").allTextContents();
assert(/\/webhooks\/in\/[0-9a-f-]{36}$/.test(address), `its address is ${address}`);
await shot(owner, "02-address-and-secret", [dialog.locator("code")]);
await dialog.getByRole("button", { name: "Continue" }).click();
await dialog.getByText("Waiting for the first post…").waitFor();
assert(
  (await send(address, secret, { name: "Live Webhook Lead", contact: { phone: "+971503009001" } })) === 202,
  "a signed test post through Caddy is accepted",
);
await dialog.getByRole("list", { name: "What the post sent" }).waitFor({ timeout: 15_000 });
await shot(owner, "03-test-post");
await dialog.getByRole("button", { name: "Use this post" }).click();
for (let i = 0; i < 3; i++) await dialog.getByRole("button", { name: "Continue" }).click();
await dialog.getByRole("button", { name: "Turn it on" }).click();
await dialog.waitFor({ state: "hidden" });
const found = await until(owner, "the test post became a lead", async () => {
  const { data } = await api(owner, "GET", "/api/v1/leads?q=Live%20Webhook%20Lead");
  return data.items.length ? data.items : null;
});
assert(found.length === 1, "the test post became one lead");

// 3 ─ A forged post: refused, counted, never kept ─────────────────────────────────────────────────
assert(
  (await send(address, "x".repeat(43), { name: "Forged Live Lead" })) === 401,
  "a forged post is refused",
);
const id = address.split("/").at(-1);
await owner.goto(`/settings/integrations/webhooks/${id}`);
await owner.getByText(/1 refused · last for a bad signature/).waitFor();
ok("the webhook's page counts the refused post, in words");
const forged = (await api(owner, "GET", "/api/v1/leads?q=Forged%20Live%20Lead")).data.items;
assert(forged.length === 0, "nothing forged got in");
await shot(owner, "04-webhook-page", [owner.locator("code")]);

// Leave the stack as it was.
for (const l of found)
  await api(owner, "POST", "/api/v1/leads/bulk", { ids: [l.id], action: { type: "delete" } });
await api(owner, "DELETE", `/api/v1/webhooks/sources/${id}`);
await api(owner, "PUT", "/api/v1/integrations/webhooks", { enabled: false });

await browser.close();
console.log("acceptance 2C passed");
