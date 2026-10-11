import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Browser, Page } from "@playwright/test";
import { roleUrl } from "@lume/db";
import { callApi, openApp, PEOPLE, stateFile, test, type Who } from "../fixtures";
import { settle } from "../settle";
import { checkStory } from "./capture";
import { Recorder } from "./recorder";
import { forgetSeen, goodStages, hidePhone, seedOnce, STORY } from "./story";

/**
 * The product tour (the interactive demo on lumecrm.in, in emails and chats), recorded: the same growing business
 * and live day as the website's captures, in Porcelain, with Calendly and Google Calendar connected as a client's
 * would be. Each scene is one problem being solved, clicked through for real (assignments, follow-ups and wins are
 * saved in this throwaway database; nothing is sent). The cursor, camera and cuts are drawn afterwards from each
 * scene's log by scripts/tour/render.py. On request only: LUME_REVIEW=1 playwright test --project demo-tour.
 * Output in e2e/__demo__/<scene>/.
 */
const OUT = "e2e/__demo__";
const VIEW = { width: 1440, height: 900 };

type Scene = {
  name: string;
  as?: Who;
  /** Where the scene opens, and anything done before the camera rolls. */
  path: string;
  before?: (page: Page) => Promise<void>;
  play: (r: Recorder, page: Page) => Promise<void>;
};

const drawer = (p: Page) => p.getByRole("dialog").first();
const idle = async (p: Page) => {
  await p.waitForLoadState("networkidle").catch(() => undefined);
  await p
    .waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 15_000 })
    .catch(() => undefined);
};
const upNext = (p: Page) => p.locator('section[aria-labelledby="up-next"]');
/** The drawer, open and done moving: aiming at a button while it slides in misses. */
const drawerIn = async (p: Page) => {
  await drawer(p).waitFor();
  await drawer(p).evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))),
  );
  await p.waitForTimeout(150);
};
/** A chip in an open popover, by its words (the chips are labelled choices, not buttons). */
const chip = (p: Page, words: string) => p.getByRole("dialog").last().getByText(words, { exact: true });

const SCENES: Scene[] = [
  {
    // 1. Leads pile up in a sheet no one owns → every enquiry in one list.
    name: "one-list",
    path: "/leads",
    before: hidePhone,
    play: async (r, p) => {
      await r.hold(900);
      const strip = p.getByRole("group", { name: "Stages" });
      await r.zoom(strip);
      await r.click(strip.getByRole("button", { name: /^Replied/ }).first());
      await idle(p);
      await r.click(strip.getByRole("button", { name: /^Call booked/ }).first(), { modifiers: ["Control"] });
      await idle(p);
      await r.hold(500);
      await r.zoom(null);
      await r.moveTo(p.getByRole("row").nth(3), [0.3, 0.5]);
      await r.scroll(420);
      await r.hold(600);
      await r.moveTo(p.getByRole("row").nth(6), [0.25, 0.5]);
      await r.hold(700);
    },
  },
  {
    // 2. New leads go cold while everyone assumes someone else replied → LUME notices, one click assigns.
    name: "needs-you",
    path: "/today",
    play: async (r, p) => {
      await r.hold(1400);
      const needs = p.getByRole("button", { name: /^Needs you/ });
      await r.click(needs);
      await r.hold(300);
      const assign = p
        .getByRole("link", { name: /^Assign/ })
        .or(p.getByRole("button", { name: /^Assign/ }))
        .first();
      await r.zoom([needs, assign]);
      await r.hold(900);
      await r.click(assign);
      await r.cut(async () => {
        await idle(p);
        await hidePhone(p);
      });
      await r.zoom(null);
      await r.click(p.getByRole("checkbox", { name: "Select all loaded" }));
      await r.hold(400);
      const island = p.getByRole("toolbar", { name: "Bulk actions" });
      await r.click(island.getByRole("button", { name: /^Assign/ }));
      const pane = p.getByRole("menu", { name: "Assign to" });
      await r.zoom(pane);
      await r.click(pane.getByRole("menuitemradio").nth(1));
      await r.hold(300);
      await r.click(pane.getByRole("button", { name: /^Assign \d/ }));
      await r.hold(1600);
      await r.zoom(null);
      await r.hold(900);
    },
  },
  {
    // 3. Follow-ups live in someone's head → one click sets the next one; anything missed comes first.
    name: "follow-up",
    path: "/leads",
    before: async (p) => {
      await hidePhone(p);
      await goodStages(p, ["Replied"]);
    },
    play: async (r, p) => {
      await r.hold(700);
      await r.click(p.getByRole("row").nth(1), { at: [0.2, 0.5] });
      await drawerIn(p);
      await r.hold(500);
      const fu = drawer(p)
        .getByRole("button", { name: /^Follow-up/ })
        .first();
      await r.click(fu);
      const set = p.getByRole("button", { name: /^Set follow-up/ });
      await set.waitFor();
      await r.zoom([fu, set]);
      await r.moveTo(chip(p, "In 3 hours"));
      await r.hold(200);
      await r.click(chip(p, "Tomorrow 10:00"));
      await r.hold(300);
      await r.click(set);
      await r.hold(1300);
      await r.zoom(null);
      await r.hold(500);
      await r.cut(async () => {
        await openApp(p, "/today");
        await idle(p);
      });
      await r.hold(700);
      await r.zoom(upNext(p));
      await r.click(upNext(p).getByRole("tab", { name: /^Overdue/ }));
      await r.hold(500);
      await r.moveTo(upNext(p).locator("li").first(), [0.35, 0.5]);
      await r.hold(1200);
      await r.zoom(null);
      await r.hold(500);
    },
  },
  {
    // 4. Typing the same WhatsApp message 40 times a day → one tap, their name already in; or a whole list.
    name: "whatsapp",
    path: "/leads",
    before: async (p) => {
      await hidePhone(p);
      await goodStages(p, ["Replied"]);
    },
    play: async (r, p) => {
      await r.hold(600);
      await r.click(p.getByRole("row").nth(2), { at: [0.2, 0.5] });
      await drawerIn(p);
      await r.hold(400);
      const wa = drawer(p)
        .getByRole("button", { name: /^WhatsApp/ })
        .first();
      await r.click(wa);
      const open = p.getByRole("button", { name: /^Open WhatsApp/ });
      await open.waitFor();
      await r.zoom([wa, open]);
      const option = (i: number) => p.getByRole("listbox", { name: "Templates" }).getByRole("option").nth(i);
      await r.moveTo(option(2), [0.4, 0.5]);
      await r.hold(250);
      await r.click(option(0), { at: [0.4, 0.5] });
      await r.hold(900);
      await r.moveTo(open);
      await r.hold(1000);
      await r.zoom(null);
      await r.hold(300);
    },
  },
  {
    // 4b. … or a whole list, one chat after another, the message ready in each.
    name: "queue",
    path: "/leads",
    before: async (p) => {
      await hidePhone(p);
      await goodStages(p, ["Replied"]);
    },
    play: async (r, p) => {
      await r.hold(700);
      await r.click(p.getByRole("checkbox", { name: "Select all loaded" }));
      const island = p.getByRole("toolbar", { name: "Bulk actions" });
      await island.waitFor();
      await r.hold(500);
      await r.click(island.getByRole("button", { name: "Message" }));
      const panel = p.getByRole("dialog", { name: "Start a send queue" });
      const group = panel.getByRole("radiogroup", { name: "Message" });
      await group.waitFor();
      const start = panel.getByRole("button", { name: /^Start/ }).first();
      await r.zoom(panel);
      await r.click(group.getByRole("radio").nth(1), { at: [0.4, 0.5] });
      await r.hold(400);
      await r.moveTo(start);
      await r.hold(1300);
      await r.zoom(null);
      await r.hold(400);
    },
  },
  {
    // 5. The call is on Calendly, the notes in a notebook, the lead in a sheet → meetings beside their lead; a win.
    name: "calendar",
    path: "/calendar",
    play: async (r, p) => {
      await r.hold(1000);
      const main = p.getByRole("main");
      await r.zoom(main.getByText("Calendly bookings arrive on their own").first());
      await r.hold(1100);
      await r.zoom(null);
      await r.moveTo(main.getByAltText("From Calendly").first());
      await r.hold(700);
      await r.moveTo(main.getByAltText("From Google Calendar").first());
      await r.hold(700);
      await r.click(
        main
          .getByRole("button", { name: /^Week/ })
          .or(main.getByRole("radio", { name: /^Week/ }))
          .first(),
      );
      await idle(p);
      await r.hold(1500);
      await r.cut(async () => {
        await openApp(p, "/leads");
        await idle(p);
        await hidePhone(p);
        await goodStages(p, ["Call booked"]);
      });
      await r.click(p.getByRole("row").nth(1), { at: [0.2, 0.5] });
      await drawerIn(p);
      await r.hold(400);
      const won = drawer(p).getByRole("button", { name: /^Won$/ });
      await r.click(won);
      const mark = p.getByRole("button", { name: /^Mark as won/ });
      await mark.waitFor();
      await r.zoom([won, mark]);
      const value = p.getByRole("dialog").last().getByRole("textbox").first();
      await r.click(value);
      await value.selectText();
      await r.type("85000", 90);
      await r.hold(250);
      await r.click(chip(p, "Premium"));
      await r.hold(300);
      await r.click(mark);
      await r.hold(1800);
      await r.zoom(null);
      await r.hold(600);
    },
  },
  {
    // 6. You can't see which source or rep is working → LUME says it in a sentence; every rep side by side.
    name: "analytics",
    path: "/analytics",
    play: async (r, p) => {
      await r.hold(1300);
      await r.click(p.getByRole("tab", { name: /^Revenue & sources/ }).first());
      await r.cut(async () => {
        await idle(p);
        await settle(p);
      });
      await r.hold(700);
      await r.moveTo([VIEW.width * 0.55, VIEW.height * 0.7]);
      await r.scroll(380);
      await r.hold(300);
      await r.zoom(p.getByRole("table").last());
      await r.moveTo(p.getByRole("row", { name: /Instagram/ }).first(), [0.85, 0.5]);
      await r.hold(900);
      await r.moveTo(p.getByRole("row", { name: /Webinars/ }).first(), [0.85, 0.5]);
      await r.hold(1100);
      await r.zoom(null);
      await r.cut(async () => {
        await p.mouse.wheel(0, -2000);
        await p.waitForTimeout(300);
      });
      await r.click(p.getByRole("tab", { name: /^Team/ }).first());
      await r.cut(() => idle(p));
      await r.hold(600);
      await r.zoom(p.getByText("Leaderboard").first().locator("xpath=ancestor::section[1]"));
      await r.moveTo(p.getByText("Aarav Mehta").first());
      await r.hold(1200);
      await r.zoom(null);
      await r.hold(500);
    },
  },
  {
    // 7a. When a rep leaves, your leads leave with them → a rep sees only their own.
    name: "rep",
    as: "seller",
    path: "/today",
    play: async (r, p) => {
      await r.hold(1200);
      await r.zoom(p.locator('main header:has(h1:has-text("Good"))'));
      await r.hold(1000);
      await r.zoom(null);
      await r.click(
        p
          .getByRole("navigation")
          .getByRole("link", { name: /^Leads/ })
          .first(),
      );
      await r.cut(() => idle(p));
      await r.hold(600);
      await r.zoom(p.getByRole("table").first());
      await r.moveTo(p.getByRole("row").nth(2));
      await r.hold(1300);
      await r.zoom(null);
      await r.hold(400);
    },
  },
  {
    // 7b. … and every export carries a hidden mark that says whose it was.
    name: "security",
    path: "/settings/security",
    play: async (r, p) => {
      await r.hold(1200);
      await r.zoom(p.getByRole("main").locator("h1").first());
      await r.hold(700);
      await r.zoom(null);
      await r.click(
        p
          .getByRole("tab", { name: /^Exports/ })
          .or(p.getByRole("link", { name: /^Exports/ }))
          .first(),
      );
      await r.cut(() => idle(p));
      await r.hold(500);
      await r.zoom(
        p.getByText("Where did this file come from?").first().locator("xpath=ancestor::section[1]"),
      );
      await r.hold(1500);
      await r.zoom(null);
      await r.hold(400);
    },
  },
];

/**
 * A client's connected calendars, as the tour shows them: Calendly as a lead source, the owner's Google Calendar
 * connected, and some of her meetings found in Google Calendar (the rest booked through Calendly). No syncs run in
 * this environment, so the rows stay as written.
 */
async function connectCalendars(now: Date) {
  const pool = new pg.Pool({ connectionString: roleUrl("lume_owner", "lume_e2e") });
  try {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const { rows: owner } = await c.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
        PEOPLE.owner.email,
      ]);
      const ownerId = owner[0]!.id;
      // Calendars and meetings are row-secured to their person: write them as the owner.
      await c.query("SELECT set_config('lume.user_id', $1, true)", [ownerId]);
      const { rows: cal } = await c.query("SELECT 1 FROM lead_sources WHERE type = 'calendly'");
      if (!cal.length)
        await c.query(
          "INSERT INTO lead_sources (id, type, name, status, created_by, created_at) VALUES ($1, 'calendly', 'Calendly', 'active', $2, $3)",
          [randomUUID(), ownerId, new Date(now.getTime() - 40 * 86_400_000)],
        );
      const { rows: conn } = await c.query<{ id: string }>(
        "SELECT id FROM calendar_connections WHERE user_id = $1",
        [ownerId],
      );
      const connId = conn[0]?.id ?? randomUUID();
      if (!conn.length)
        await c.query(
          `INSERT INTO calendar_connections (id, user_id, google_email, grant_enc, calendars, status, last_synced_at, next_sync_at)
           VALUES ($1, $2, 'maya@brightpath.example', '\\x00'::bytea, $3::jsonb, 'active', $4, $5)`,
          [
            connId,
            ownerId,
            JSON.stringify([{ id: "primary", name: "Maya Kapoor", chosen: true }]),
            new Date(now.getTime() - 2 * 60_000),
            new Date(now.getTime() + 3 * 60_000),
          ],
        );
      // Every other one of the owner's meetings this fortnight was found in her calendar, not booked on a page.
      await c.query(
        `UPDATE meetings SET source = 'google', matched_by = 'attendee', connection_id = $1, calendar_id = 'primary'
          WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER (ORDER BY starts_at) AS n FROM meetings
                        WHERE owner_id = $2 AND starts_at BETWEEN $3 AND $4 AND source = 'calendly') m WHERE n % 2 = 0)`,
        [connId, ownerId, new Date(now.getTime() - 7 * 86_400_000), new Date(now.getTime() + 7 * 86_400_000)],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  } finally {
    await pool.end();
  }
}

async function record(browser: Browser, scene: Scene) {
  const ctx = await browser.newContext({
    storageState: stateFile(scene.as ?? "owner"),
    colorScheme: "light",
    viewport: VIEW,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  const dir = `${OUT}/${scene.name}`;
  try {
    await forgetSeen();
    await openApp(page, scene.path);
    await idle(page);
    if (scene.before) await scene.before(page);
    await idle(page);
    await settle(page);
    const r = new Recorder(page, dir, VIEW);
    await r.start();
    try {
      await scene.play(r, page);
    } finally {
      await r.stop({ scene: scene.name });
    }
    return null;
  } catch (e) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/failed.png` }).catch(() => undefined);
    // What a popup that measures as visible but can't be seen is doing (opacity, place, parent).
    const why = await page
      .evaluate(() =>
        [...document.querySelectorAll('[role="dialog"]')].map((el) => {
          const c = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            label: el.getAttribute("aria-label"),
            parent: el.parentElement?.tagName + "." + el.parentElement?.className,
            opacity: c.opacity,
            visibility: c.visibility,
            position: c.position,
            z: c.zIndex,
            anim: c.animationName + " " + c.animationPlayState,
            attrs: [...el.attributes].map((a) => `${a.name}=${a.value.slice(0, 80)}`).join(" "),
            rect: [r.x, r.y, r.width, r.height].map(Math.round),
            top: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.outerHTML.slice(0, 160),
          };
        }),
      )
      .catch((e) => String(e));
    writeFileSync(`${dir}/why.json`, JSON.stringify(why, null, 2));
    return `${scene.name}: ${(e as Error).message.split("\n")[0]}`;
  } finally {
    await ctx.close();
  }
}

test.describe("demo tour", () => {
  test.setTimeout(3_600_000);

  test("every scene of the product tour, recorded", async ({ browser }) => {
    mkdirSync(OUT, { recursive: true });
    const now = new Date();
    await seedOnce(now);
    await connectCalendars(now);
    const owner = await browser.newContext({ storageState: stateFile("owner") });
    const page = await owner.newPage();
    await openApp(page, "/today");
    const broken = await checkStory(page, STORY);
    // The test suite's two placeholder leads have no place in a client's list (removed as the owner would).
    const found = await callApi<{
      items?: { id: string; name: string }[];
      leads?: { id: string; name: string }[];
    }>(page, "GET", "/api/v1/leads?ownerId=none&q=Unassigned&limit=20");
    for (const l of (found.data.items ?? found.data.leads ?? []).filter((x) =>
      /^Unassigned (One|Two)$/.test(x.name),
    ))
      await callApi(page, "DELETE", `/api/v1/leads/${l.id}`);
    await owner.close();
    if (broken.length) throw new Error(`The story isn't true yet:\n- ${broken.join("\n- ")}`);
    const only = process.env.TOUR_SCENES?.split(",");
    const failed: string[] = [];
    for (const scene of SCENES) {
      if (only && !only.includes(scene.name)) continue;
      const f = await record(browser, scene);
      if (f) failed.push(f);
    }
    writeFileSync(`${OUT}/manifest.json`, JSON.stringify({ recordedAt: now.toISOString(), failed }, null, 2));
    if (failed.length) console.warn(`Scenes failed:\n- ${failed.join("\n- ")}`);
  });
});
