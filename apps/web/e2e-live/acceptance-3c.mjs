// Phase 3C live acceptance, on the running dev stack through Caddy's TLS, as the owner:
//   - a stage's automation set through Pipeline & stages; a lead moved there gets its follow-up, and its
//     history says LUME set it;
//   - a win clears the lead's open follow-ups;
//   - Settings → Follow-ups (leads gone quiet, working hours, time choices) and Business → Working hours;
//   - System health, at a glance.
// Screenshots go to docs/runbooks/screenshots-3c, full content (owner, 2026-09-28). Needs ACCEPT_STATE_DIR.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const STATE = process.env.ACCEPT_STATE_DIR;
if (!STATE) throw new Error("ACCEPT_STATE_DIR is required (run acceptance-1c1.mjs first)");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-3c");
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
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1366, height: 800 },
  storageState: path.join(STATE, "owner.json"),
});
const page = await ctx.newPage();
const go = async (url) => {
  await page.goto(`${BASE}${url}`);
  await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
};
const shot = async (name, target = page) => {
  await page.waitForTimeout(700);
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`) }); // full content: nothing masked
};
const api = (method, url, body) =>
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

await go("/leads");
const { pipelines } = (await api("GET", "/api/v1/pipelines")).data;
const stages = pipelines.find((p) => p.isDefault).stages.sort((a, b) => a.position - b.position);
// The second open stage, whatever this install calls it (LUME names no client's stages).
const target = stages.filter((s) => s.kind === "open")[1];
const won = stages.find((s) => s.kind === "won");
assert(target && won, `a stage to automate ("${target?.name}") and a Won stage`);
assert(
  won.onEnter?.rules?.some((r) => r.type === "cancel_open_tasks"),
  "a new install's Won clears open follow-ups",
);

// 1. The automation, through the screen.
await go("/settings/pipeline");
await page.getByRole("button", { name: `Automations for ${target.name}` }).click();
const sheet = page.getByRole("dialog", { name: `What ${target.name} does` });
await sheet.getByRole("button", { name: "Set a follow-up" }).click();
await sheet.getByLabel("Follow-up title").fill("Send the plan");
await sheet.getByLabel("How long after").fill("2");
await sheet.getByLabel("Hours or days").selectOption("day");
await shot("01-automation-sheet", sheet);
await sheet.getByRole("button", { name: "Save" }).click();
await sheet.waitFor({ state: "hidden" });
await page.getByRole("list", { name: "What each stage does" }).getByText("Send the plan").waitFor();
ok(`${target.name} sets a follow-up when a lead enters it`);
await shot("02-pipeline-summary");

// 2. A lead moved there has it, and its history says LUME set it.
const lead = (await api("POST", "/api/v1/leads", { name: "Rule Follower" })).data?.lead;
assert(lead?.id, "a lead");
const moved = await api("POST", `/api/v1/leads/${lead.id}/stage`, { stageId: target.id });
assert(moved.status === 200, `moved to ${target.name}`);
const open = async () =>
  (await api("GET", `/api/v1/leads/${lead.id}/tasks`)).data.items.filter((t) => t.status === "open");
const tasks = await open();
assert(tasks.length === 1 && tasks[0].title === "Send the plan", "its follow-up was set by the stage", tasks);
await go(`/leads?lead=${lead.id}`);
const drawer = page.getByRole("dialog", { name: "Rule Follower" });
await drawer.getByRole("region", { name: "Next follow-up" }).getByText("Send the plan").waitFor();
await drawer.getByRole("tab", { name: "History" }).click();
await drawer.getByText("LUME set a follow-up").waitFor();
ok("the drawer shows it, and its history says LUME set it");
await shot("03-drawer-history", drawer);

// 3. Won clears it.
await api("POST", `/api/v1/leads/${lead.id}/stage`, { stageId: won.id });
assert((await open()).length === 0, "Won cleared its open follow-up");

// 4. The settings, as they read.
await go("/settings/follow-ups");
await page.getByRole("list", { name: "Time choices" }).waitFor();
await shot("04-settings-follow-ups");
await page.setViewportSize({ width: 1366, height: 1400 });
await shot("05-settings-follow-ups-full");
await page.setViewportSize({ width: 1366, height: 800 });
await go("/settings/business");
const hours = page.getByRole("form", { name: "Working hours" });
await hours.scrollIntoViewIfNeeded();
await shot("06-working-hours", hours);

// 5. System health.
await go("/settings/health");
const headline = await page.getByRole("heading", { level: 2 }).first().textContent();
ok(`System health says: "${headline}"`);
await page.getByRole("region", { name: "Follow-up reminders" }).waitFor();
await shot("07-system-health");

// Tidy: the stage does nothing again, and the lead goes.
await api("PATCH", `/api/v1/stages/${target.id}`, { onEnter: { rules: [] } });
await api("POST", "/api/v1/leads/bulk", { ids: [lead.id], action: { type: "delete" } });
console.log("acceptance 3C passed");
await browser.close();
