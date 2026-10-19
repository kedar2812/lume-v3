import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, hydrated, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/** Send feedback (spec 2026-10-16): from LUME, through its API, to the fake licence server — and what got there. */
const FAKE = "http://127.0.0.1:3113/__fake/feedback";

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
/** A screenshot-like PNG made in the page: a grey sidebar, a white sheet, rows of "text", and noise everywhere. */
async function picture(page: Page, w = 1600, h = 900): Promise<Buffer> {
  const b64 = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d")!;
      x.fillStyle = "#eef0f3";
      x.fillRect(0, 0, w, h);
      x.fillStyle = "#ffffff";
      x.fillRect(w * 0.15, 8, w * 0.85 - 8, h - 16);
      for (let i = 0; i < 14; i++) {
        x.fillStyle = i % 2 ? "#0a0c11" : "#2a5bff";
        for (let j = 0; j < 40; j++) x.fillRect(w * 0.18 + j * 9, 60 + i * 50, 6, 14);
      }
      const d = x.getImageData(0, 0, w, h);
      for (let k = 0; k < d.data.length; k += 4) d.data[k] = (Math.imul(k, 2654435761) >>> 24) & 255;
      x.putImageData(d, 0, 0);
      return c.toDataURL("image/png").split(",")[1]!;
    },
    [w, h] as const,
  );
  return Buffer.from(b64, "base64");
}
type Sent = { last: Record<string, unknown> | null; count: number };
const lastReport = async (page: Page) => (await (await page.request.get(FAKE)).json()) as Sent;
async function openFromPalette(page: Page, path: string) {
  await openApp(page, path);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("feedback");
  await page.getByRole("option", { name: /Send feedback/ }).click();
  return page.getByRole("dialog", { name: "Send feedback" });
}

test.describe("Send feedback", () => {
  test.use({ storageState: stateFile("seller") });
  test.afterEach(async ({ page }) => {
    await page.request.post(FAKE, { data: {} });
  });

  test("from the profile menu: words, a kind, a screenshot blurred over the names, sent — Porcelain and Obsidian", async ({
    page,
  }) => {
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/leads?q=Ananya");
      await page.locator('[data-tour="profile"]').click();
      await page.getByRole("menuitem", { name: "Send feedback" }).click();
      const sheet = page.getByRole("dialog", { name: "Send feedback" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Send" })).toBeDisabled();
      await reviewCopy(page, `empty-${theme}.png`);
      expect(await axe(page)).toEqual([]);

      await sheet.getByText("Something's confusing").click();
      await sheet.getByLabel("What happened?").fill("A meeting I booked for 4 pm shows at 3:30.");
      await sheet
        .getByLabel("Choose images")
        .setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: await picture(page) });
      await expect(sheet.getByRole("img", { name: "Screenshot 1" })).toBeVisible({ timeout: 15_000 });
      await sheet.getByRole("button", { name: "Blur screenshot 1" }).click();
      const blur = page.getByRole("dialog", { name: "Blur private parts" });
      const area = blur.getByRole("img", { name: /The screenshot/ });
      const box = (await area.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.18, box.y + box.height * 0.06);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.4, { steps: 8 });
      await page.mouse.up();
      await expect(blur.getByText("1 area blurred")).toBeVisible();
      await reviewCopy(page, `blur-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await blur.getByRole("button", { name: "Done" }).click();
      await expect(sheet.getByRole("button", { name: "Blur screenshot 1" })).toHaveText("Blurred", {
        timeout: 15_000,
      });
      await reviewCopy(page, `filled-${theme}.png`);
      const before = (await lastReport(page)).count;
      await sheet.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("Sent. Thank you.")).toBeVisible();
      await expect(sheet).toBeHidden();

      const { last, count } = await lastReport(page);
      expect(count).toBe(before + 1);
      expect(last).toMatchObject({
        kind: "confusing",
        text: "A meeting I booked for 4 pm shows at 3:30.",
        page: "/leads",
        theme: theme === "dark" ? "obsidian" : "porcelain",
        reporter: { name: "Noor Ahmed", email: "noor@brightpath.test" },
      });
      const [img] = last!.images as { type: string; data: string }[];
      expect(img!.type).toBe("image/webp");
      // Under the box the picture is blocks of one colour: next to each other, pixels barely differ. Outside it, the
      // noise is all still there.
      const rough = await page.evaluate(async (data) => {
        const el = new Image();
        el.src = `data:image/webp;base64,${data}`;
        await el.decode();
        const c = document.createElement("canvas");
        c.width = el.naturalWidth;
        c.height = el.naturalHeight;
        const x = c.getContext("2d")!;
        x.drawImage(el, 0, 0);
        const step = (sx: number, sy: number) => {
          const d = x.getImageData(sx, sy, 48, 48).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) if ((i / 4) % 48 < 47) sum += Math.abs(d[i]! - d[i + 4]!);
          return sum / (47 * 48);
        };
        return {
          blurred: step(Math.round(c.width * 0.3), Math.round(c.height * 0.2)),
          plain: step(Math.round(c.width * 0.7), Math.round(c.height * 0.6)),
        };
      }, img!.data);
      expect(rough.plain, JSON.stringify(rough)).toBeGreaterThan(20);
      expect(rough.blurred, JSON.stringify(rough)).toBeLessThan(rough.plain / 5);
    }
  });

  test("a 4K screenshot is made small enough to send", async ({ page }) => {
    const sheet = await openFromPalette(page, "/today");
    await sheet.getByLabel("What happened?").fill("Big screen");
    await sheet
      .getByLabel("Choose images")
      .setInputFiles({ name: "4k.png", mimeType: "image/png", buffer: await picture(page, 3840, 2160) });
    await expect(sheet.getByRole("img", { name: "Screenshot 1" })).toBeVisible({ timeout: 30_000 });
    await sheet.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Sent. Thank you.")).toBeVisible();
    const [img] = (await lastReport(page)).last!.images as { data: string }[];
    expect(Buffer.from(img!.data, "base64").length).toBeLessThanOrEqual(1_572_864);
  });

  test("when LUME's team can't be reached, everything stays and Try again sends it", async ({ page }) => {
    await page.request.post(FAKE, { data: { status: 503 } });
    const sheet = await openFromPalette(page, "/calendar");
    await sheet.getByLabel("What happened?").fill("Calendar is off by 30 minutes");
    await sheet.getByRole("button", { name: "Send" }).click();
    await expect(sheet.getByRole("alert")).toHaveText(
      "LUME couldn't reach its team just now. Your report is still here. Try again in a minute.",
    );
    await reviewCopy(page, "not-sent.png");
    await expect(sheet.getByLabel("What happened?")).toHaveValue("Calendar is off by 30 minutes");
    await page.request.post(FAKE, { data: {} });
    await sheet.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Sent. Thank you.")).toBeVisible();
    expect((await lastReport(page)).last).toMatchObject({
      text: "Calendar is off by 30 minutes",
      page: "/calendar",
    });
  });

  test("on a phone: from More, the whole screen", async ({ browser }) => {
    const ctx = await browser.newContext({
      storageState: stateFile("seller"),
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.goto("/leads");
    await hydrated(page);
    await page.locator('html[data-shell="ready"]').waitFor({ state: "attached" });
    await page.getByRole("navigation", { name: "Tabs" }).getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Send feedback" }).click();
    const sheet = page.getByRole("dialog", { name: "Send feedback" });
    await expect(sheet).toBeVisible();
    const b = (await sheet.boundingBox())!;
    expect(Math.round(b.width)).toBe(390);
    await reviewCopy(page, "phone.png");
    expect(await axe(page)).toEqual([]);
    await ctx.close();
  });
});
