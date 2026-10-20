import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import sharp from "sharp";
import { expect, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * Media (plan 2026-10-20-media-tab, Task 11), end to end: the real API and web app, previews through the render
 * stand-in (e2e/render-fake.mjs), PDFs drawn by the real pdf.js in its worker. On a computer and on a phone.
 */

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

/** A real PDF, one page per line, its cross-reference table counted, so pdf.js reads it as any PDF. */
function pdf(lines: string[]): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>"];
  objects.push(
    `<< /Type /Pages /Kids [${lines.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${lines.length} >>`,
  );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  lines.forEach((text, i) => {
    const stream = `BT /F1 30 Tf 72 680 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const at: number[] = [];
  objects.forEach((b, i) => {
    at.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${b}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A photo of a finished room, drawn here (fictional, like all of LUME's sample content). */
const room = (sky: string, sofa: string) =>
  sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
      <rect width="1600" height="1000" fill="${sky}"/><rect x="140" y="140" width="420" height="480" rx="8" fill="#f6f2ea"/>
      <rect y="760" width="1600" height="240" fill="#cdbfa9"/><rect x="700" y="470" width="720" height="240" rx="50" fill="${sofa}"/>
      <rect x="660" y="560" width="800" height="200" rx="40" fill="${sofa}" opacity=".85"/><circle cx="1480" cy="380" r="90" fill="#8aa37c"/>
    </svg>`),
  )
    .jpeg({ quality: 86 })
    .toBuffer();
const MP4 = Buffer.concat([
  Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2", "latin1"),
  Buffer.alloc(4096, 1),
]);

const grid = (page: Page) => page.getByRole("list", { name: "Your media" });
const tile = (page: Page, name: string) =>
  grid(page).getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}`) });

test.describe("Media", () => {
  test("an admin adds files by their content, opens each in LUME, and shares one by link", async ({
    page,
    browser,
  }) => {
    await openApp(page, "/media");
    // Nothing yet: the page teaches it.
    await expect(
      page.getByRole("heading", { name: "Your brochures, photos and videos, in one place" }),
    ).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page, `empty-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });

    // One at a time, so their order is known: newest first, the brochure, the photo, then the video. (Dropped
    // together, files go up three at once and land in the order they finish.)
    const add = async (name: string, mimeType: string, buffer: Buffer) => {
      await page.locator('input[type="file"]').setInputFiles([{ name, mimeType, buffer }]);
      await expect(tile(page, name)).toBeVisible({ timeout: 20_000 });
    };
    await add("Site visit.mp4", "video/mp4", MP4);
    await add("Living room, finished.jpg", "image/jpeg", await room("#e7e1d8", "#7f8f86"));
    await add(
      "Brochure 2026.pdf",
      "application/pdf",
      pdf(["Brightpath Interiors", "Our prices", "Our work"]),
    );
    // Each thumbnail arrives once it's made (the page looks again while previews are made).
    await expect(tile(page, "Brochure 2026.pdf").locator("img")).toBeVisible({ timeout: 20_000 });
    await expect(tile(page, "Living room, finished.jpg").locator("img")).toBeVisible({ timeout: 20_000 });
    await expect(tile(page, "Brochure 2026.pdf")).toContainText("PDF · 3 pages");
    await expect(tile(page, "Site visit.mp4")).toContainText("0:42");

    // The guide: three icon steps, put away for good.
    const guide = page.getByRole("region", { name: "How Media works" });
    await expect(guide).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(() => document.querySelectorAll("img").forEach((i) => (i.loading = "eager")));
      await settle(page);
      await reviewCopy(page, `grid-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await guide.getByRole("button", { name: "Got it" }).click();
    await expect(guide).toBeHidden();
    await page.reload();
    await expect(tile(page, "Brochure 2026.pdf")).toBeVisible();
    await expect(page.getByRole("region", { name: "How Media works" })).toHaveCount(0);

    // A PDF opens in LUME: pdf.js draws its pages, and Find in it finds a word.
    await tile(page, "Brochure 2026.pdf").click();
    const viewer = page.getByRole("dialog", { name: "Brochure 2026.pdf" });
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('[data-page="1"] canvas[data-ready]')).toBeVisible({ timeout: 20_000 });
    await expect(viewer).toContainText("Page 1 of 3");
    await viewer.getByRole("button", { name: "Find in it" }).click();
    await viewer.getByRole("searchbox", { name: "Find in Brochure 2026.pdf" }).fill("prices");
    await expect(viewer.getByRole("status").filter({ hasText: /of|Not/ })).toHaveText("1 of 1", {
      timeout: 15_000,
    });
    await expect(viewer).toContainText("Page 2 of 3");
    await reviewCopy(page, "viewer-pdf.png");
    expect(await axe(page)).toEqual([]);
    await viewer.getByRole("button", { name: "Close Find" }).click();

    // Right arrow: the next file, a photo; it zooms.
    await page.keyboard.press("ArrowRight");
    const photo = page.getByRole("dialog", { name: "Living room, finished.jpg" });
    await expect(photo).toBeVisible();
    await expect(photo.getByRole("img", { name: "Living room, finished.jpg" })).toBeVisible();
    await expect(photo).toContainText("Photo · 1600 × 1000");
    await photo.getByRole("button", { name: "Zoom in" }).click();
    await expect(photo.getByRole("group", { name: "Zoom" })).toContainText("150%");
    await photo
      .getByRole("group", { name: "Zoom" })
      .getByRole("button", { name: /fit to the window/ })
      .click();

    // Info: where it goes, and Share by link.
    await photo.getByRole("button", { name: "Info" }).click();
    const info = photo.getByRole("complementary", { name: "Info" });
    await expect(info).toContainText("Sends as the real file from any lead's WhatsApp tab");
    await info.getByRole("switch", { name: "Share Living room, finished.jpg by link" }).click();
    const url = (await info.getByText(/\/f\/[A-Za-z0-9_-]{43}$/).textContent())!;
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page, `viewer-photo-info-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    const stranger = await browser.newContext();
    expect((await stranger.request.get(url)).status()).toBe(200);
    await stranger.close();

    // Escape: back to Media, on the photo's tile, which now says Link on.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(tile(page, "Living room, finished.jpg")).toBeFocused();
    await expect(tile(page, "Living room, finished.jpg")).toContainText("Link on");
    // Leave nothing shared behind: the specs after this one expect no file shared by link (the send sheet's Add a
    // file shows only when one is).
    await tile(page, "Living room, finished.jpg").click();
    await page.getByRole("dialog").getByRole("button", { name: "Info" }).click();
    await page.getByRole("switch", { name: "Share Living room, finished.jpg by link" }).click();
    await expect(page.getByText("Anyone with the old link now sees nothing.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tile(page, "Living room, finished.jpg")).not.toContainText("Link on");
  });

  test("a rep opens Media and plays a video, and can't add or change anything", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("seller") });
    const page = await ctx.newPage();
    await openApp(page, "/media");
    await expect(tile(page, "Site visit.mp4")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add media" })).toHaveCount(0);
    await page
      .getByRole("region", { name: "How Media works" })
      .getByRole("button", { name: "Got it" })
      .click();
    await tile(page, "Site visit.mp4").click();
    const viewer = page.getByRole("dialog", { name: "Site visit.mp4" });
    const video = viewer.locator("video");
    await expect(video).toHaveAttribute("playsinline", "");
    for (const name of ["Play", "Back 10 seconds", "Sound off", "Full screen"])
      await expect(viewer.getByRole("button", { name })).toBeVisible();
    await expect(viewer.getByRole("slider", { name: "Position" })).toHaveAttribute(
      "aria-valuetext",
      "0:00 of 0:42",
    );
    await viewer.getByRole("button", { name: "Info" }).click();
    await expect(
      viewer.getByRole("complementary", { name: "Info" }).getByRole("button", { name: "Archive" }),
    ).toHaveCount(0);
    await reviewCopy(page, "viewer-video-rep.png");
    expect(await axe(page)).toEqual([]);
    await ctx.close();
  });

  test("on a phone: two columns, a swipe moves between files, and a pinch zooms the photo, not the page", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      storageState: stateFile("owner"),
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    const page = await ctx.newPage();
    await openApp(page, "/media");
    await expect(tile(page, "Brochure 2026.pdf")).toBeVisible();
    const columns = await grid(page).evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
    );
    expect(columns).toBe(2);
    // Thumbnails show even when the browser had them before the page came alive.
    await expect(tile(page, "Brochure 2026.pdf").locator("img")).toHaveAttribute("data-loaded", "true");
    await expect(tile(page, "Living room, finished.jpg").locator("img")).toHaveAttribute(
      "data-loaded",
      "true",
    );
    await expect(page.getByRole("button", { name: "Add from this phone" })).toBeVisible();
    await settle(page);
    await reviewCopy(page, "phone-grid.png");
    expect(await axe(page)).toEqual([]);

    await tile(page, "Brochure 2026.pdf").click();
    await expect(page.getByRole("dialog", { name: "Brochure 2026.pdf" })).toBeVisible();
    // A swipe to the left: the next file.
    const stage = page.getByRole("dialog").locator('[class*="stageArea"]');
    const box = (await stage.boundingBox())!;
    const y = box.y + box.height / 2;
    await stage.dispatchEvent("pointerdown", {
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
      clientX: 330,
      clientY: y,
      button: 0,
    });
    for (const x of [300, 250, 190, 120])
      await stage.dispatchEvent("pointermove", {
        pointerId: 7,
        pointerType: "touch",
        isPrimary: true,
        clientX: x,
        clientY: y,
      });
    await stage.dispatchEvent("pointerup", {
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
      clientX: 120,
      clientY: y,
    });
    await expect(page.getByRole("dialog", { name: "Living room, finished.jpg" })).toBeVisible();

    // Two fingers apart on the photo: it zooms; the page itself stays as it is.
    const img = page.getByRole("img", { name: "Living room, finished.jpg" });
    const on = page.getByRole("dialog").locator('[class*="imageStage"]');
    const c = (await on.boundingBox())!;
    const cx = c.x + c.width / 2;
    const cy = c.y + c.height / 2;
    await on.dispatchEvent("pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      clientX: cx - 30,
      clientY: cy,
    });
    await on.dispatchEvent("pointerdown", {
      pointerId: 2,
      pointerType: "touch",
      clientX: cx + 30,
      clientY: cy,
    });
    await on.dispatchEvent("pointermove", {
      pointerId: 1,
      pointerType: "touch",
      clientX: cx - 90,
      clientY: cy,
    });
    await on.dispatchEvent("pointermove", {
      pointerId: 2,
      pointerType: "touch",
      clientX: cx + 90,
      clientY: cy,
    });
    await on.dispatchEvent("pointerup", {
      pointerId: 1,
      pointerType: "touch",
      clientX: cx - 90,
      clientY: cy,
    });
    await on.dispatchEvent("pointerup", {
      pointerId: 2,
      pointerType: "touch",
      clientX: cx + 90,
      clientY: cy,
    });
    await expect(page.getByRole("group", { name: "Zoom" })).toContainText("300%");
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
    await expect(img).toBeVisible();
    await reviewCopy(page, "phone-viewer-photo.png");

    // Info is a sheet from the bottom.
    await page.getByRole("button", { name: "Info", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Info" })).toBeVisible();
    await settle(page);
    await reviewCopy(page, "phone-info-sheet.png");
    expect(await axe(page)).toEqual([]);
    await ctx.close();
  });
});
