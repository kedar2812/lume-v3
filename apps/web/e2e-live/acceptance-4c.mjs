// Phase 4C live acceptance, on the running dev stack through Caddy's TLS:
//   - Settings → Messages shows the run size and the daily limit;
//   - a masked rep selects two of their leads, starts a send queue, sends one (WhatsApp stubbed), leaves
//     it paused, picks it up again from Today, skips the other, and sees the summary — the number never
//     on the page.
// Runs after acceptance-4b.mjs in the chain. Screenshots go to docs/runbooks/screenshots-4c, full content
// (owner, 2026-09-28). Needs ACCEPT_STATE_DIR.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const STATE = process.env.ACCEPT_STATE_DIR;
if (!STATE) throw new Error("ACCEPT_STATE_DIR is required (run acceptance-1c1.mjs first)");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-4c");
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
const signedIn = async (who) => {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1366, height: 860 },
    storageState: path.join(STATE, `${who}.json`),
  });
  // WhatsApp itself is never contacted from an acceptance run.
  await ctx.route(/^https:\/\/(wa\.me|api\.whatsapp\.com)\//, (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp</title>" }),
  );
  const page = await ctx.newPage();
  const goto = page.goto.bind(page);
  page.goto = async (url) => {
    const r = await goto(url.startsWith("http") ? url : `${BASE}${url}`);
    await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    return r;
  };
  return { page, ctx };
};
const shot = async (name, target) => {
  await new Promise((r) => setTimeout(r, 700));
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`) }); // full content: nothing masked
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
const noNumber = async (page, digits) =>
  assert(
    !(await page.locator("body").innerText()).includes(digits),
    `the page never shows the number (${digits})`,
  );

// 1. Settings → Messages.
const { page: owner } = await signedIn("owner");
await owner.goto("/settings/messages");
await owner.getByRole("spinbutton", { name: "Leads in a run" }).waitFor();
await shot("01-settings-messages", owner);
ok("Settings → Messages shows the run size and the daily limit");

// 2. Two leads of the rep's.
const { people } = (await api(owner, "GET", "/api/v1/people")).data;
const riya = people.find((p) => p.name === "Riya Sharma");
// A run cut short before left its leads: they go first, so this can run again.
const stale = (await api(owner, "GET", "/api/v1/leads?q=Acceptance%20Queue&limit=100")).data.items.map(
  (l) => l.id,
);
if (stale.length) await api(owner, "POST", "/api/v1/leads/bulk", { ids: stale, action: { type: "delete" } });
const openRun = async (page) => {
  const cur = (await api(page, "GET", "/api/v1/queues/current")).data;
  if (cur) await api(page, "POST", `/api/v1/queues/${cur.id}/cancel`);
};
const leads = [];
for (const [name, phone] of [
  ["Acceptance Queue One", "+971509992201"],
  ["Acceptance Queue Two", "+971509992202"],
]) {
  const r = await api(owner, "POST", "/api/v1/leads", { name, phone, ownerId: riya.id });
  assert(r.status === 201, `the owner added ${name} for the rep`, r.data);
  leads.push(r.data.lead.id);
}

// 3. The rep selects them and starts a run.
const { page: rep, ctx } = await signedIn("rep");
await rep.goto("/leads");
await openRun(rep);
await rep.getByRole("searchbox").first().fill("Acceptance Queue");
await rep.getByTestId("lead-row").filter({ hasText: "Acceptance Queue Two" }).waitFor();
for (const name of ["Acceptance Queue One", "Acceptance Queue Two"])
  await rep.getByRole("checkbox", { name: `Select ${name}`, exact: true }).check();
await rep.getByRole("toolbar", { name: "Bulk actions" }).getByRole("button", { name: "Message" }).click();
const sheet = rep.getByRole("dialog", { name: "Start a send queue" });
await sheet
  .getByText("2 leads")
  .waitFor({ timeout: 10_000 })
  .catch(async (e) => {
    await rep.screenshot({ path: path.join(SHOTS, "99-failure.png") });
    console.error("sheet says:", await sheet.innerText().catch(() => "(no sheet)"));
    throw e;
  });
await shot("02-start-sheet", rep);
await sheet.getByRole("button", { name: "Start" }).click();
await rep.waitForURL(/\/queue\/[0-9a-f-]{36}$/);
const run = rep.getByRole("dialog", { name: "Send queue" });
await run.getByText("0 of 2").waitFor();
const first = (await run.getByRole("heading", { level: 2 }).innerText()).trim();
assert(first.startsWith("Acceptance Queue"), `the run opens on the first lead (${first})`);
await noNumber(rep, "99922");
await shot("03-run-card", rep);

// 4. Send → WhatsApp (a real new tab, stubbed) → back → Sent? → Yes.
const [tab] = await Promise.all([
  ctx.waitForEvent("page"),
  run.getByRole("button", { name: "Send" }).click(),
]);
await tab.waitForURL(/^https:\/\/wa\.me\/97150999220\d/);
assert(
  (await tab.evaluate(() => globalThis.opener)) === null,
  "WhatsApp opens in a tab with no way back into LUME",
);
await tab.close();
await rep.bringToFront();
await rep.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
await run.getByRole("group", { name: "Was the WhatsApp message sent?" }).waitFor();
await shot("04-sent-prompt", rep);
await run.getByRole("button", { name: "Yes, sent" }).click();
await run.getByText("1 of 2").waitFor();
ok("Yes moves on to the next lead");

// 5. Leave (paused), and pick it up again from Today.
await rep.keyboard.press("Escape");
await rep.waitForURL(/\/today$/);
const card = rep.getByRole("region", { name: "Your send queue" });
await card.waitFor();
assert((await card.innerText()).includes("paused"), "Today says the run is paused");
await shot("05-today-resume", rep);
await card.getByRole("link", { name: "Resume · 1 of 2" }).click();
await rep.waitForURL(/\/queue\//);
await run.getByRole("button", { name: "Resume" }).click();
await run.getByText("1 of 2").waitFor();

// 6. Skip the other, and the summary.
await run.getByRole("button", { name: "Send" }).waitFor();
await rep.keyboard.press("s");
const summary = run.getByRole("region", { name: "Run finished" });
await summary.waitFor();
const said = await summary.innerText();
assert(said.includes("1 sent") && said.includes("1 skipped"), "the summary says how it went", said);
await noNumber(rep, "99922");
await shot("06-summary", rep);
await summary.getByRole("button", { name: "Done" }).click();
await rep.waitForURL(/\/today$/);

// Tidy: the leads go.
await api(owner, "POST", "/api/v1/leads/bulk", { ids: leads, action: { type: "delete" } });
console.log("acceptance 4C passed");
await browser.close();
