// Phase 4B live acceptance, on the running dev stack through Caddy's TLS:
//   - a fresh install's four starter views are in the sidebar, each with a count;
//   - the owner filters (Overdue follow-up), saves "Chase list" shared with Sales, and it opens as a view;
//   - a masked rep sees it with their own count, and the list agrees; they can't edit it.
// Runs after acceptance-4a.mjs in the chain. Screenshots go to docs/runbooks/screenshots-4b, full content
// (owner, 2026-09-28). Needs ACCEPT_STATE_DIR.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const STATE = process.env.ACCEPT_STATE_DIR;
if (!STATE) throw new Error("ACCEPT_STATE_DIR is required (run acceptance-1c1.mjs first)");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-4b");
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
  const page = await ctx.newPage();
  const goto = page.goto.bind(page);
  page.goto = async (url) => {
    const r = await goto(url.startsWith("http") ? url : `${BASE}${url}`);
    await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    return r;
  };
  return page;
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
const viewsList = (page) => page.getByRole("list", { name: "Views" });
const countIn = async (link) => {
  const m = /(\d[\d,]*|—)\s*$/.exec(await link.innerText());
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
};

// 1. The starters.
const owner = await signedIn("owner");
await owner.goto("/leads");
const { views } = (await api(owner, "GET", "/api/v1/views")).data;
const starters = ["My overdue", "New today", "No reply 3+ days", "Lost — re-engage"];
assert(
  starters.every((n) => views.some((v) => v.name === n)),
  "a fresh install has the four starter views",
  views.map((v) => v.name),
);
for (const n of starters)
  await viewsList(owner)
    .getByRole("link", { name: new RegExp(`^${n.replace(/[+]/g, "\\+")}`) })
    .waitFor();
await shot("01-sidebar-views", owner.locator("aside").first());

// 2. Overdue follow-ups, one the rep's and one the owner's.
const { people } = (await api(owner, "GET", "/api/v1/people")).data;
const riya = people.find((p) => p.name === "Riya Sharma");
const me = people.find((p) => p.name === "Maya Kapoor");
const leads = [];
for (const [name, who] of [
  ["Acceptance Rep Overdue", riya],
  ["Acceptance Owner Overdue", me],
]) {
  const l = (await api(owner, "POST", "/api/v1/leads", { name, ownerId: who.id })).data.lead;
  leads.push(l.id);
  await api(owner, "POST", `/api/v1/leads/${l.id}/tasks`, {
    title: "Chase",
    due: { at: new Date(Date.now() - 2 * 3_600_000).toISOString() },
    assigneeId: who.id,
  });
}

// 3. Save and share a view from the filters.
await owner.goto("/leads");
await owner.getByRole("button", { name: /more filters/i }).click();
await owner.getByRole("switch", { name: "Overdue follow-up" }).check();
await shot("02-more-filters", owner.getByRole("dialog", { name: "More filters" }));
await owner.keyboard.press("Escape");
await owner.getByRole("button", { name: "Save view" }).click();
const form = owner.getByRole("dialog", { name: "Save view" });
await form.getByRole("textbox", { name: "Name" }).fill("Acceptance chase");
await form.getByRole("radio", { name: "Share with roles" }).check();
await form.getByRole("checkbox", { name: "Sales" }).check({ force: true });
await shot("03-save-view", form);
await form.getByRole("button", { name: "Save" }).click();
await owner.getByRole("heading", { name: "Acceptance chase" }).waitFor();
ok("the owner saved “Acceptance chase”, shared with Sales, and it opened as a view");
await shot("04-open-view", owner);

// 4. The rep's own count, and the list agrees.
const rep = await signedIn("rep");
await rep.goto("/today");
const theirs = viewsList(rep).getByRole("link", { name: /^Acceptance chase/ });
await theirs.waitFor();
let repCount = NaN;
for (let i = 0; i < 20 && Number.isNaN(repCount); i++) {
  repCount = await countIn(theirs);
  if (Number.isNaN(repCount)) await new Promise((r) => setTimeout(r, 250));
}
assert(repCount >= 1, `the rep sees the shared view with their own count (${repCount})`);
await theirs.click();
await rep.waitForURL(/\/leads\?view=/);
const rows = await rep.getByTestId("lead-row").count();
assert(rows === repCount, `the rep's list agrees with the count (${rows})`);
assert(
  (await rep.getByTestId("lead-row").filter({ hasText: "Acceptance Owner Overdue" }).count()) === 0,
  "and never shows the owner's lead",
);
assert(
  (await viewsList(rep).getByRole("button", { name: "Edit Acceptance chase" }).count()) === 0,
  "a view shared with them isn't theirs to change",
);
await shot("05-rep-view", rep);

// Tidy: the view and the leads go.
const mine = (await api(owner, "GET", "/api/v1/views")).data.views.find((v) => v.name === "Acceptance chase");
if (mine) await api(owner, "DELETE", `/api/v1/views/${mine.id}`);
await api(owner, "POST", "/api/v1/leads/bulk", { ids: leads, action: { type: "delete" } });
console.log("acceptance 4B passed");
await browser.close();
