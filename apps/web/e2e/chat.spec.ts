import { callApi, expect, openApp, stateFile, test } from "./fixtures";
import { cutText, spills } from "./spills";
import { settle } from "./settle";

/** Team Chat (plan 2026-11-24-team-chat-2a, Task 7): nothing runs off screen, and two people talk live. */
test.use({ storageState: stateFile("owner") });

const LONG = "x".repeat(300);
for (const size of [
  { width: 1366, height: 800 },
  { width: 390, height: 844 },
])
  for (const theme of ["porcelain", "obsidian"] as const)
    test(`nothing in Chat runs off screen at ${size.width}×${size.height} (${theme})`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize(size);
      await context.addCookies([{ name: "lume_theme", value: theme, url: "http://127.0.0.1:3100" }]);
      await openApp(page, "/chat");
      const list = await callApi<{ channels: { id: string; name: string }[] }>(page, "GET", "/api/v1/chat");
      const general = list.data.channels.find((c) => c.name === "general")!;
      for (const body of [
        "word ".repeat(800).trim(),
        LONG,
        "🎉🙌🔥".repeat(40),
        "یہ ایک لمبا پیغام ہے ".repeat(20),
      ])
        await callApi(page, "POST", `/api/v1/chat/${general.id}/messages`, {
          clientId: crypto.randomUUID(),
          body,
        });
      await openApp(page, `/chat?c=${general.id}`);
      await page.waitForLoadState("networkidle");
      await settle(page);
      expect(await spills(page)).toEqual([]);
      expect(await cutText(page)).toEqual([]);
      // The box to write in is on screen, with nothing over it (the phone's tab bar floats).
      const box = page.getByRole("textbox", { name: "Message #general" });
      await expect(box).toBeInViewport();
      expect(
        await box.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el === document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        }),
      ).toBe(true);
      // It grows with what's written, to a point, and the page still fits.
      await box.fill("line\n".repeat(40));
      expect(await spills(page)).toEqual([]);
      await expect(page.getByRole("button", { name: "Send" })).toBeInViewport();
      await box.fill("");
      if (size.width < 700) await page.getByRole("button", { name: "Back" }).click();
      for (const [open, sheet] of [
        ["New direct message", "New direct message"],
        ["Manage channels", "Channels"],
      ] as const) {
        await page.getByRole("button", { name: open }).click();
        const d = page.getByRole("dialog", { name: sheet });
        await expect(d).toBeVisible();
        await settle(page);
        expect(await spills(page)).toEqual([]);
        if (sheet === "Channels") {
          await d.getByRole("button", { name: "New channel" }).click();
          const form = page.getByRole("dialog", { name: "New channel" });
          await form.getByRole("textbox", { name: "Name" }).fill(LONG);
          await settle(page);
          expect(await spills(page)).toEqual([]);
        }
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
    });

test("the team talks about a lead on the lead itself, and a message is deleted only when asked twice", async ({
  page,
}) => {
  await openApp(page, "/leads");
  const leads = await callApi<{ items: { id: string }[] }>(page, "GET", "/api/v1/leads?limit=1");
  for (const size of [
    { width: 1366, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await openApp(page, `/leads?lead=${leads.data.items[0]!.id}`);
    await page.getByRole("tab", { name: "Team" }).click();
    const box = page.getByRole("textbox", { name: /^Message / });
    const words = `On the lead ${size.width} ${Date.now()}`;
    await box.fill(words);
    await page.keyboard.press("Enter");
    const mine = page.getByRole("group").filter({ hasText: words });
    await expect(mine).toBeVisible();
    await settle(page);
    expect(await spills(page)).toEqual([]);
    const send = await page.getByRole("button", { name: "Send" }).boundingBox();
    expect(send!.y + send!.height).toBeLessThanOrEqual(size.height);
    // Kept by the server under its own id, not the one being sent.
    await expect(mine).not.toHaveAttribute("data-pending", /.*/);
    await mine.hover();
    await mine.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText(words)).toBeVisible();
    await mine.getByRole("button", { name: "Delete for everyone?" }).click();
    await expect(page.getByText(words)).toHaveCount(0);
  }
});

test("two people talk live: the message lands without a reload", async ({ browser, page }) => {
  await openApp(page, "/chat");
  const list = await callApi<{ channels: { id: string; name: string }[] }>(page, "GET", "/api/v1/chat");
  const general = list.data.channels.find((c) => c.name === "general")!;
  await openApp(page, `/chat?c=${general.id}`);
  // Noor: the one teammate past Welcome whichever specs have run.
  const other = await browser.newContext({ storageState: stateFile("seller") });
  const p2 = await other.newPage();
  await openApp(p2, `/chat?c=${general.id}`);
  const words = `Live ${Date.now()}`;
  await p2.getByRole("textbox", { name: "Message #general" }).fill(words);
  await p2.keyboard.press("Enter");
  await expect(page.getByText(words)).toBeVisible({ timeout: 10_000 });
  await other.close();
});
