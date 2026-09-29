// Phase 4A live acceptance, on the running dev stack through Caddy's TLS:
//   - a fresh install has LUME's starter templates, by kind, and each stage's moves from its preset;
//   - a masked rep sends a template from the lead's drawer: the page never shows the number, the tab opens
//     to wa.me, Sent is confirmed, and the lead moves on as its stage says;
//   - They replied is logged and moves it on again; the history says which template, and the reply.
// Runs after acceptance-3c.mjs in the chain. Screenshots go to docs/runbooks/screenshots-4a, full content
// (owner, 2026-09-28). Needs ACCEPT_STATE_DIR.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const STATE = process.env.ACCEPT_STATE_DIR;
if (!STATE) throw new Error("ACCEPT_STATE_DIR is required (run acceptance-1c1.mjs first)");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-4a");
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
  // WhatsApp itself is never contacted from an acceptance run: its pages answer with a stub.
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
  return page;
};
const shot = async (name, target) => {
  await target.page?.().waitForTimeout(700);
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

// 1. The starters, and the moves, on a fresh install.
const owner = await signedIn("owner");
await owner.goto("/templates");
const { templates } = (await api(owner, "GET", "/api/v1/templates")).data;
assert(templates.length >= 6, `a fresh install has LUME's starter templates (${templates.length})`);
const kinds = new Set(templates.map((t) => t.category));
assert(kinds.has("first_touch") && kinds.has("follow_up"), "among them a first touch and a follow-up");
await owner.getByRole("list", { name: "First touch" }).waitFor();
await shot("01-templates", owner);
await owner
  .getByRole("button", { name: new RegExp(`^${templates[0].name.replace(/[()]/g, "\\$&")}`) })
  .click();
const editor = owner.getByRole("dialog", { name: templates[0].name });
await editor.getByRole("figure", { name: "Preview" }).waitFor();
await shot("02-template-editor", owner);
await owner.keyboard.press("Escape");

const { pipelines } = (await api(owner, "GET", "/api/v1/pipelines")).data;
const stages = pipelines.find((p) => p.isDefault).stages.sort((a, b) => a.position - b.position);
const first = stages.find((s) => s.kind === "open");
const name = (id) => stages.find((s) => s.id === id)?.name;
const afterSent = name(first.afterSentStageId);
assert(afterSent, `the first stage (${first.name}) moves a lead to ${afterSent} once a message is sent`);
const afterReply = name(stages.find((s) => s.id === first.afterSentStageId)?.afterReplyStageId);

// 2. A lead of the rep's, which the owner makes.
const { people } = (await api(owner, "GET", "/api/v1/people")).data;
const riya = people.find((p) => p.name === "Riya Sharma");
const made = await api(owner, "POST", "/api/v1/leads", {
  name: "Acceptance Messaging",
  phone: "+971509990077",
  ownerId: riya.id,
});
assert(made.status === 201, "a lead for the rep");
const leadId = made.data.lead.id;

// 3. The rep sends a starter from the drawer.
const rep = await signedIn("rep");
await rep.goto(`/leads?lead=${leadId}`);
const drawer = rep.getByRole("dialog", { name: "Acceptance Messaging", exact: true });
await drawer.getByRole("button", { name: "WhatsApp" }).click();
const sheet = rep.getByRole("dialog", { name: "WhatsApp Acceptance Messaging" });
const firstTouch = templates.find((t) => t.category === "first_touch");
await sheet.getByRole("option", { name: new RegExp(firstTouch.name) }).click();
const words = await sheet.getByRole("textbox", { name: "Message" }).inputValue();
assert(
  words.includes("Acceptance") && !words.includes("{{lead.first_name}}"),
  "it renders in the lead's words",
  words,
);
await shot("03-send-sheet", drawer);
const [tab] = await Promise.all([
  rep.context().waitForEvent("page"),
  rep.getByRole("button", { name: "Open WhatsApp" }).click(),
]);
await tab.waitForURL(/^https:\/\/wa\.me\/971509990077/);
assert(
  (await tab.evaluate(() => globalThis.opener)) === null,
  "WhatsApp opens in its own tab, cut off from LUME",
);
await tab.close();
await rep.bringToFront();
const body = await rep.locator("body").innerText();
assert(!/9990077|999 0077|wa\.me/.test(body), "the page never shows the number or the link");
await rep.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
const prompt = drawer.getByRole("group", { name: "Was the WhatsApp message sent?" });
await prompt.waitFor();
await shot("04-sent-prompt", drawer);
await prompt.getByRole("button", { name: "Yes, sent" }).click();
await drawer.getByRole("status").getByText(`Moved to ${afterSent}`, { exact: false }).waitFor();
ok(`Sent: the lead moved to ${afterSent}`);
await shot("05-sent-moved", drawer);

// 4. They replied.
await drawer.getByRole("button", { name: "They replied" }).click();
const said = afterReply ? `They replied · Moved to ${afterReply}` : "They replied";
await rep.getByText(said).waitFor();
ok(`They replied${afterReply ? `: moved to ${afterReply}` : ""}`);
await drawer.getByRole("tab", { name: "History" }).click();
const history = drawer.getByRole("tabpanel");
await history.getByText(`from “${firstTouch.name}”`, { exact: false }).waitFor();
await history.getByText("They replied", { exact: true }).waitFor();
ok("the history says which template was sent, and the reply");
await shot("06-drawer-history", drawer);

// 5. The Moves, where an admin sets them.
await owner.goto("/settings/pipeline");
await owner.getByText(`After a message is sent: moves to ${afterSent}`).waitFor();
await owner.getByRole("button", { name: `Automations for ${first.name}` }).click();
const does = owner.getByRole("dialog", { name: `What ${first.name} does` });
await does.getByRole("group", { name: "Moves" }).waitFor();
await shot("07-stage-moves", does);
await owner.keyboard.press("Escape");

// Tidy: the lead goes.
await api(owner, "POST", "/api/v1/leads/bulk", { ids: [leadId], action: { type: "delete" } });
console.log("acceptance 4A passed");
await browser.close();
