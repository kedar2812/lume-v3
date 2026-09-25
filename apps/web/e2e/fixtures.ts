import { readFile } from "node:fs/promises";
import path from "node:path";
import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { totpCode } from "@lume/core";

const ARTIFACTS = path.resolve(import.meta.dirname, ".artifacts");
export type Who = "owner" | "admin" | "rep" | "seller" | "fresh";
export const stateFile = (who: Who) => path.join(ARTIFACTS, `${who}.json`);

export const PEOPLE = {
  owner: { email: "owner@nupuur.test", name: "Nupuur Patil", password: "a long and lovely passphrase" },
  admin: { email: "tasneem@nupuur.test", name: "Tasneem Shaikh", password: "sunrise over the creek at five" },
  rep: { email: "riya@nupuur.test", name: "Riya Sharma", password: "sunrise over the creek at five" },
  /** For the password-reset spec, which signs him out everywhere; nobody else relies on his session. */
  aman: { email: "aman@nupuur.test", name: "Aman Verma", password: "sunrise over the creek at five" },
  /** Sales, onboarded at seed time (through the API), so the leads specs can use a rep straight away. */
  seller: { email: "noor@nupuur.test", name: "Noor Ahmed", password: "sunrise over the creek at five" },
  /** Joined but hasn't agreed to the licence agreement, terms and privacy policy yet (the gate's own specs). */
  fresh: { email: "zara@nupuur.test", name: "Zara Malik", password: "sunrise over the creek at five" },
} as const;

/** The token the API printed at boot, read the way an operator reads it: from the log. */
export async function readSetupToken(): Promise<string> {
  for (let i = 0; i < 120; i++) {
    const log = await readFile(path.join(ARTIFACTS, "api.log"), "utf8").catch(() => "");
    const token = [...log.matchAll(/setup token: ([A-Za-z0-9_-]+)/g)].at(-1)?.[1];
    if (token) return token;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the API never printed a setup token");
}

export type Mail = { to: string[]; subject: string; text: string; at: string };
const MAIL_API = `http://127.0.0.1:${process.env.E2E_MAIL_API_PORT ?? 3111}/messages`;

/** The newest message to `email` that arrived after `since` (ISO time), waiting up to 15 seconds. */
export async function lastMailTo(request: APIRequestContext, email: string, since = ""): Promise<Mail> {
  for (let i = 0; i < 60; i++) {
    const all = (await (await request.get(MAIL_API)).json()) as Mail[];
    const mine = all.filter((m) => m.to.includes(email) && m.at > since).at(-1);
    if (mine) return mine;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no mail arrived for ${email}`);
}

/** The path of the invite or reset link in an email. */
export function linkIn(mail: Mail, kind: "invite" | "reset"): string {
  const m = new RegExp(`https?://[^\\s"<>]*/${kind}/([A-Za-z0-9_-]{20,})`).exec(mail.text);
  if (!m) throw new Error(`no ${kind} link in that email:\n${mail.text.slice(0, 600)}`);
  return `/${kind}/${m[1]}`;
}

/** Types a real, current two-step code for the secret shown on screen into the six boxes. */
export async function enterCode(page: Page): Promise<void> {
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  await page.getByLabel("Digit 1 of 6").click();
  await page.keyboard.type(totpCode(secret, Date.now()));
}

/**
 * Calls the API from inside the page, with the page's own cookies and a CSRF token, exactly as the app
 * does. (Playwright's separate request client won't send the Secure session cookie over plain http.)
 */
export async function callApi<T = unknown>(
  page: Page,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  return page.evaluate(
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
}

/**
 * The first-use agreement: read to the end of the licence agreement, terms and privacy policy, then
 * agree. "I agree" must be locked until the end is reached.
 */
export async function agreeToTerms(page: Page): Promise<void> {
  await page.waitForURL(/\/agree$/);
  const agree = page.getByRole("button", { name: "I agree" });
  await expect(agree).toBeDisabled();
  const reader = page.getByRole("region", { name: "Licence agreement, terms of service and privacy policy" });
  await reader.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(agree).toBeEnabled();
  await agree.click();
}

/** Opens an app page and waits until the shell's keyboard shortcuts are live (after hydration). */
export async function openApp(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('html[data-shell="ready"]').waitFor({ state: "attached" });
}

/** The page's own alert. Next.js adds an empty role="alert" route announcer, which is not ours. */
export const alertIn = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

/** For pages from a hand-made browser context, which don't get the fixture's automatic wait. */
export const hydrated = (page: Page) => page.locator("html[data-hydrated]").waitFor({ state: "attached" });

/**
 * Every navigation waits until React has hydrated the page, so a click or key press can never land on
 * server-rendered HTML that isn't listening yet (the cause of a flaky run, found and fixed).
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const goto = page.goto.bind(page);
    page.goto = async (url, options) => {
      const response = await goto(url, options);
      await page.locator("html[data-hydrated]").waitFor({ state: "attached", timeout: 15_000 });
      return response;
    };
    await use(page);
  },
});
export { expect };
