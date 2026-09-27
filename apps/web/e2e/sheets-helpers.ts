import type { Page } from "@playwright/test";
import { callApi } from "./fixtures";

const FAKE = `http://127.0.0.1:${process.env.E2E_GOOGLE_PORT ?? 3112}`;
export const HEAD = ["Timestamp", "Name", "Phone", "Email"];
let n = 0;

/** A fresh spreadsheet in the fake Google, shared with LUME; its id. */
export async function putSheet(rows: string[][], title = "Website enquiries"): Promise<string> {
  const id = `1E2eSheet${Date.now()}${n++}xxxxxxxxxxxx`;
  const { email } = (await (await fetch(`${FAKE}/__fake/key`)).json()) as { email: string };
  await fetch(`${FAKE}/__fake/spreadsheets/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      sharedWith: [email],
      tabs: [{ sheetId: 0, title: "Form responses", rows: [HEAD, ...rows] }],
    }),
  });
  return id;
}
export const appendRows = (id: string, rows: string[][]) =>
  fetch(`${FAKE}/__fake/spreadsheets/${id}/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab: "Form responses", rows }),
  });
export const sheetLink = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;

/** Switch Sheets on and connect a sheet through the API, as the page's user; the source's id. */
export async function connectViaApi(
  page: Page,
  id: string,
  startFrom: "all" | "new" = "all",
): Promise<string> {
  await callApi(page, "PUT", "/api/v1/integrations/google-sheets", { enabled: true });
  const d = (
    await callApi<{ draft: { id: string } }>(page, "POST", "/api/v1/sheets/drafts", {
      link: sheetLink(id),
      sheetId: 0,
    })
  ).data;
  const s = (
    await callApi<{ id: string }>(page, "POST", "/api/v1/sheets/sources", {
      importId: d.draft.id,
      name: "Website enquiries",
      pollSeconds: 3600,
      startFrom,
    })
  ).data;
  return s.id;
}
