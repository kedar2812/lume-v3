import type { Locator, Page } from "@playwright/test";
import { callApi, openApp } from "./fixtures";

type ImportView = { id: string; status: string; mine: boolean; seenAt: string | null; sourceId: string };

/**
 * Opens Leads → Import on a fresh sheet. A finished import not yet looked at would open its report
 * instead (by design), so those are marked seen first.
 */
export async function openImportSheet(page: Page, over = "/leads"): Promise<Locator> {
  await openApp(page, over);
  const { imports } = (await callApi<{ imports: ImportView[] }>(page, "GET", "/api/v1/imports")).data;
  for (const i of imports.filter(
    (x) => x.mine && !x.seenAt && ["done", "failed", "stopped_access"].includes(x.status),
  ))
    await callApi(page, "POST", `/api/v1/imports/${i.id}/seen`);
  if (imports.some((x) => x.mine && !x.seenAt)) await openApp(page, over); // the dot is read on load
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Import leads" });
  await sheet.getByRole("heading", { name: "Choose a file" }).waitFor();
  return sheet;
}

/** Chooses a file in the File step and waits until LUME has read it. */
export async function chooseFile(sheet: Locator, name: string, text: string): Promise<void> {
  await sheet
    .getByLabel("Choose a CSV file")
    .setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(text) });
  await sheet.getByText(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · `)).waitFor();
}

/** Continue to the next step (every step's footer has one). */
export const next = (sheet: Locator) => sheet.getByRole("button", { name: "Continue" }).click();

/** An import through the API, as the page's user, run to the end. For tests that only need its result. */
export async function importViaApi(
  page: Page,
  name: string,
  text: string,
  rules: Record<string, unknown> = {},
): Promise<ImportView> {
  const draft = await page.evaluate(
    async ({ name, text }) => {
      const { token } = await (await fetch("/api/v1/auth/csrf")).json();
      const res = await fetch("/api/v1/imports", {
        method: "POST",
        headers: {
          "x-csrf-token": token,
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(name),
        },
        body: text,
      });
      return (await res.json()) as { id: string; rules: Record<string, unknown> };
    },
    { name, text },
  );
  if (Object.keys(rules).length)
    await callApi(page, "PATCH", `/api/v1/imports/${draft.id}`, { rules: { ...draft.rules, ...rules } });
  const started = await callApi<ImportView>(page, "POST", `/api/v1/imports/${draft.id}/start`);
  if (started.status !== 200) throw new Error(`start refused: ${JSON.stringify(started.data)}`);
  for (let i = 0; i < 120; i++) {
    const v = (await callApi<ImportView>(page, "GET", `/api/v1/imports/${draft.id}`)).data;
    if (!["queued", "running", "cancelling"].includes(v.status)) {
      await callApi(page, "POST", `/api/v1/imports/${draft.id}/seen`);
      return v;
    }
    await page.waitForTimeout(500);
  }
  throw new Error("the import never finished");
}

/** Deletes every lead an import created (bulk, 100 at a time), so later specs see the seeded workspace. */
export async function deleteLeadsFrom(page: Page, sourceId: string): Promise<void> {
  for (;;) {
    const { items } = (
      await callApi<{ items: { id: string }[] }>(page, "GET", `/api/v1/leads?source=${sourceId}&limit=100`)
    ).data;
    if (!items.length) return;
    await callApi(page, "POST", "/api/v1/leads/bulk", {
      ids: items.map((l) => l.id),
      action: { type: "delete" },
    });
  }
}

/** The import a file name was last uploaded as (newest first). */
export async function importNamed(page: Page, fileName: string): Promise<ImportView & { fileName: string }> {
  const { imports } = (
    await callApi<{ imports: (ImportView & { fileName: string })[] }>(page, "GET", "/api/v1/imports")
  ).data;
  const found = imports.find((i) => i.fileName === fileName);
  if (!found) throw new Error(`no import of ${fileName}`);
  return found;
}
