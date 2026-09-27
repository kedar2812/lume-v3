// Phase 2B-1 live acceptance: Google Sheets and Refresh on the running dev stack, through Caddy's TLS, as
// the owner — spec 2026-09-27-phase-2b §1: connect a sheet once, its rows become leads, Refresh gives the
// real count. Screenshots go to docs/runbooks/screenshots-2b1.
//
// Needs a real Google service-account key on the box (secrets/google-sa.json, picked up by
// gen-dev-env.sh) and, for steps 2–3, ACCEPT_SHEET_LINK: a test sheet shared with its email as a Viewer.
// Without the key it checks what it can and says what it skipped. Runs after acceptance-1c1.mjs in the
// same throwaway container, with the sessions handed over in ACCEPT_STATE_DIR.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const STATE = process.env.ACCEPT_STATE_DIR;
const LINK = process.env.ACCEPT_SHEET_LINK;
if (!STATE) throw new Error("ACCEPT_STATE_DIR is required (run acceptance-1c1.mjs first)");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-2b1");
mkdirSync(SHOTS, { recursive: true });

const ok = (msg) => console.log(`ok   ${msg}`);
const skip = (msg) => console.log(`SKIP ${msg}`);
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
const shot = async (page, name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), mask: [page.locator('[class*="clock"]')] });
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

const owner = await signedIn("owner");

// 1 ─ Settings → Integrations: off by default ─────────────────────────────────────────────────────
await owner.goto("/settings/integrations");
await owner.locator("#settings-title", { hasText: "Integrations" }).waitFor();
const before = (await api(owner, "GET", "/api/v1/integrations")).data;
assert(before.googleSheets.enabled === false, "Google Sheets is off until someone switches it on");
await shot(owner, "01-integrations-off");
if (!before.googleSheets.available) {
  assert(
    (await owner.getByText(/isn't set up on this server yet/).count()) === 1,
    "without a Google key, the page says who can set it up",
  );
  skip("no Google key on this box (put it at /root/lume-dev/secrets/google-sa.json, then dev.sh up)");
  await browser.close();
  console.log("acceptance 2B-1: step 1 passed; steps 2–3 need a Google key");
  process.exit(0);
}
await owner.getByRole("switch", { name: "Google Sheets" }).click();
await owner.getByText(before.googleSheets.email).waitFor();
ok(`switched on; share sheets with ${before.googleSheets.email}`);
await shot(owner, "02-integrations-on");

if (!LINK) {
  skip("no ACCEPT_SHEET_LINK: set it to a test sheet shared with the email above");
  await browser.close();
  console.log("acceptance 2B-1: steps 1 passed; steps 2–3 need a sheet");
  process.exit(0);
}

// 2 ─ Add a sheet through the steps; its rows become leads ────────────────────────────────────────
await owner.getByRole("button", { name: "Add a sheet" }).click();
const dialog = owner.getByRole("dialog", { name: "Add a sheet" });
await dialog.getByLabel("Sheet link").fill(LINK);
await dialog.getByRole("button", { name: "Check" }).click();
await dialog.getByLabel("Tab").waitFor();
await shot(owner, "03-sheet-step");
for (let i = 0; i < 4; i++) await dialog.getByRole("button", { name: "Continue" }).click();
await shot(owner, "04-start-from");
await dialog.getByRole("button", { name: "Connect sheet" }).click();
await dialog.waitFor({ state: "hidden" });
let source = null;
for (let i = 0; i < 60 && !source; i++) {
  const { data } = await api(owner, "GET", "/api/v1/sheets/sources");
  source = data.sources.find((s) => !s.syncing && s.lastSyncedAt) ?? null;
  if (!source) await owner.waitForTimeout(1000);
}
assert(source, "the first sync finished within a minute");
assert(source.newAllTime > 0, `its rows became leads (${source.newAllTime})`, source);
await owner.goto(`/settings/integrations/${source.id}`);
await owner.getByRole("table", { name: "Recent syncs" }).waitFor();
await shot(owner, "05-sheet-page");

// 3 ─ Refresh on Leads gives the real count ───────────────────────────────────────────────────────
await owner.goto("/leads");
await owner.getByRole("button", { name: "Refresh", exact: true }).click();
const status = owner.getByRole("status").filter({ hasText: /new lead|Up to date|Couldn't reach/ });
await status.waitFor({ timeout: 30_000 });
const said = await status.textContent();
assert(/new lead|Up to date/.test(said ?? ""), `Refresh said: “${said}”`);
await shot(owner, "06-refresh-result");

await browser.close();
console.log("acceptance 2B-1 passed");
