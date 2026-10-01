import { createHash, createSign } from "node:crypto";
import { columnLetter } from "@lume/core";

/** The key file Google issues for a service account, as LUME needs it. */
export type ServiceAccount = { clientEmail: string; privateKey: string; tokenUri: string };
export type SheetTab = { sheetId: number; title: string; rowCount: number };
export type SpreadsheetMeta = { title: string; tabs: SheetTab[] };
/**
 * access: this sheet isn't shared (or was unshared); setup: LUME's own Google key or project needs fixing;
 * gone: Google's 410 (a calendar's sync token expired: read it in full again).
 */
export type GoogleErrorKind =
  "access" | "not_found" | "rate" | "unavailable" | "bad_request" | "setup" | "gone";

/** Google's error reasons that mean "slow down", which Drive sends as 403 (not 429). */
const RATE_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
]);
/** Reasons that mean the Google project itself isn't set up for LUME (an API not enabled, a bad key). */
const SETUP_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED", "keyInvalid", "projectNotLinked"]);
type GoogleErrorBody = {
  error?: {
    message?: string;
    status?: string;
    errors?: { reason?: string }[];
    details?: { reason?: string }[];
  };
};
const reasonsOf = (b: GoogleErrorBody) =>
  [...(b.error?.errors ?? []), ...(b.error?.details ?? [])].map((x) => x.reason ?? "").filter(Boolean);

/** What a passing failure to reach Google is recorded as (the page tells it from LUME's own failures). */
export const GOOGLE_UNREACHABLE = "Couldn't reach Google.";

export class GoogleError extends Error {
  constructor(
    readonly kind: GoogleErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}
/** A failure that passes on its own (Google busy or out of quota): try again later, don't pause the sheet. */
export const isTransient = (e: unknown): boolean =>
  e instanceof GoogleError && (e.kind === "rate" || e.kind === "unavailable");

/** What LUME asks of Google: read-only, one spreadsheet at a time. */
export type GoogleSheets = {
  readonly email: string;
  modifiedTime(spreadsheetId: string): Promise<string>;
  spreadsheet(spreadsheetId: string): Promise<SpreadsheetMeta>;
  /**
   * Each A1 range's rows as Google formats them (or, unformatted, as stored: a date as its serial number):
   * trailing empty cells and rows are left out.
   */
  values(spreadsheetId: string, ranges: string[], o?: { unformatted?: boolean }): Promise<string[][][]>;
};

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
].join(" ");
const RETRIES = [1000, 2000, 4000];

export function parseServiceAccount(b64: string | undefined): ServiceAccount | null {
  if (!b64) return null;
  try {
    const j = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
    if (typeof j.client_email !== "string" || typeof j.private_key !== "string") return null;
    return {
      clientEmail: j.client_email,
      privateKey: j.private_key,
      tokenUri: typeof j.token_uri === "string" ? j.token_uri : "https://oauth2.googleapis.com/token",
    };
  } catch {
    return null;
  }
}

/** A sheet's link (or its bare id) → the spreadsheet id, and the tab it pointed at when it says. */
export function parseSheetLink(link: string): { spreadsheetId: string; gid: number | null } | null {
  const text = link.trim();
  const inUrl = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(text);
  const bare = /^[A-Za-z0-9_-]{25,}$/.test(text) ? text : null;
  const spreadsheetId = inUrl?.[1] ?? bare;
  if (!spreadsheetId) return null;
  const gid = /[#?&]gid=(\d+)/.exec(text);
  return { spreadsheetId, gid: gid ? Number(gid[1]) : null };
}

/** Whole rows `from`..`to` of one tab, in A1 notation, the title quoted as Google requires. */
/** One column (0-based) of rows `from`..`to`, in A1 notation. */
export const columnRange = (tab: string, column: number, from: number, to: number): string =>
  `'${tab.replace(/'/g, "''")}'!${columnLetter(column)}${from}:${columnLetter(column)}${to}`;

export const rowsRange = (tab: string, from: number, to: number): string =>
  `'${tab.replace(/'/g, "''")}'!${from}:${to}`;

const b64url = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** Where access tokens come from; `force` skips the cache (after a 401). */
export type TokenSource = (force?: boolean) => Promise<string>;

/** The service account (2B-1): a signed JWT exchanged for an hour's access token, cached until near expiry. */
export function serviceAccountTokens(o: {
  account: ServiceAccount;
  fetch?: typeof fetch;
  now?: () => number;
}): TokenSource {
  const http = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  let token: { value: string; until: number } | null = null;
  return async (force = false) => {
    if (!force && token && now() < token.until) return token.value;
    const iat = Math.floor(now() / 1000);
    const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
      iss: o.account.clientEmail,
      scope: SCOPES,
      aud: o.account.tokenUri,
      iat,
      exp: iat + 3600,
    })}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(o.account.privateKey, "base64url");
    let res: Response;
    try {
      res = await http(o.account.tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: `${unsigned}.${sig}`,
        }),
      });
    } catch {
      throw new GoogleError("unavailable", "LUME couldn't reach Google.");
    }
    if (res.status >= 500) throw new GoogleError("unavailable", "Google's sign-in service is unavailable.");
    if (!res.ok)
      throw new GoogleError(
        "setup",
        "Google refused LUME's service-account key (it may have been deleted or disabled).",
      );
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, until: now() + (j.expires_in - 60) * 1000 };
    return token.value;
  };
}

/** "Connect with Google" (2B §6): access tokens come from the relay, which alone holds the client secret. */
export function relayTokens(o: {
  relayUrl: string;
  relayToken: string;
  refreshToken: string;
  fetch?: typeof fetch;
  now?: () => number;
}): TokenSource {
  const http = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  let token: { value: string; until: number } | null = null;
  return async (force = false) => {
    if (!force && token && now() < token.until) return token.value;
    let res: Response;
    try {
      res = await http(`${o.relayUrl}/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${o.relayToken}`, "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: o.refreshToken }),
      });
    } catch {
      throw new GoogleError("unavailable", "LUME couldn't reach its Google connector.");
    }
    const j = (await res.json().catch(() => ({}))) as {
      accessToken?: string;
      expiresIn?: number;
      error?: string;
    };
    // The relay doesn't know this instance (removed, or its token changed on one side only).
    if (res.status === 401)
      throw new GoogleError(
        "setup",
        "This LUME isn't registered with its Google connector (the relay) any more.",
      );
    if (res.status === 400 && j.error === "revoked")
      throw new GoogleError("access", "Google access for this sheet was removed. Connect it again.");
    if (!res.ok || !j.accessToken)
      throw new GoogleError("unavailable", "LUME's Google connector didn't answer.");
    token = { value: j.accessToken, until: now() + ((j.expiresIn ?? 3600) - 60) * 1000 };
    return token.value;
  };
}

/**
 * Token sources for OAuth-connected sheets, kept across syncs so an access token (good for an hour) is
 * reused rather than asked of the relay on every sync (2B-2 final review, Important 3). Keyed by the relay,
 * this instance's token and the grant, so a changed token or a new grant starts fresh.
 */
const relaySources = new Map<string, TokenSource>();
const RELAY_SOURCES_MAX = 1000;

/** The kept token source for one grant (a sheet's or a calendar's). */
export function grantTokens(oauth: { relayUrl: string; relayToken: string }, grant: string): TokenSource {
  const key = createHash("sha256").update(`${oauth.relayUrl}\n${oauth.relayToken}\n${grant}`).digest("hex");
  let tokens = relaySources.get(key);
  if (!tokens) {
    if (relaySources.size >= RELAY_SOURCES_MAX) relaySources.delete(relaySources.keys().next().value!);
    tokens = relayTokens({ ...oauth, refreshToken: grant });
    relaySources.set(key, tokens);
  }
  return tokens;
}

/** A client for one OAuth-connected sheet; null when Connect with Google isn't configured here. */
export const oauthClientFor =
  (oauth: { relayUrl: string; relayToken: string } | null | undefined, endpoint?: string) =>
  (cfg: { grant?: string }): GoogleSheets | null => {
    if (!oauth || !cfg.grant) return null;
    return createGoogleSheets({
      tokens: grantTokens(oauth, cfg.grant),
      email: "",
      ...(endpoint ? { endpoint } : {}),
    });
  };

/** The read-only client, from a service account (2B-1) or any token source (Connect with Google, 2B-2). */
export function createGoogleSheets(
  o: ({ account: ServiceAccount } | { tokens: TokenSource; email: string }) & {
    endpoint?: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): GoogleSheets {
  const sheetsBase = o.endpoint ?? "https://sheets.googleapis.com";
  const driveBase = o.endpoint ?? "https://www.googleapis.com";
  const tokens =
    "tokens" in o
      ? o.tokens
      : serviceAccountTokens({
          account: o.account,
          ...(o.fetch ? { fetch: o.fetch } : {}),
          ...(o.now ? { now: o.now } : {}),
        });
  const email = "tokens" in o ? o.email : o.account.clientEmail;
  const call = googleCaller({
    tokens,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });

  const enc = encodeURIComponent;
  return {
    email,
    async modifiedTime(id) {
      const j = await call<{ modifiedTime: string }>(
        `${driveBase}/drive/v3/files/${enc(id)}?fields=modifiedTime&supportsAllDrives=true`,
      );
      return j.modifiedTime;
    },
    async spreadsheet(id) {
      const j = await call<{
        properties: { title: string };
        sheets: { properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number } } }[];
      }>(
        `${sheetsBase}/v4/spreadsheets/${enc(id)}?fields=${enc("properties.title,sheets.properties(sheetId,title,gridProperties.rowCount)")}`,
      );
      return {
        title: j.properties.title,
        tabs: j.sheets.map((s) => ({
          sheetId: s.properties.sheetId,
          title: s.properties.title,
          rowCount: s.properties.gridProperties?.rowCount ?? 0,
        })),
      };
    },
    async values(id, ranges, o = {}) {
      const qs = ranges.map((r) => `ranges=${enc(r)}`).join("&");
      const render = o.unformatted
        ? "valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER"
        : "valueRenderOption=FORMATTED_VALUE";
      const j = await call<{ valueRanges?: { values?: unknown[][] }[] }>(
        `${sheetsBase}/v4/spreadsheets/${enc(id)}/values:batchGet?majorDimension=ROWS&${render}&${qs}`,
      );
      return ranges.map((_, i) =>
        (j.valueRanges?.[i]?.values ?? []).map((row) => row.map((c) => String(c ?? ""))),
      );
    },
  };
}

/**
 * One authorised GET against a Google API, as every LUME client makes it: a 401 refreshes the access token
 * once; Google busy (429, a rate reason, 5xx, the network) is retried 1, 2, 4 s apart; then a GoogleError.
 */
export function googleCaller(o: {
  tokens: TokenSource;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): <T>(url: string) => Promise<T> {
  const http = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let force = false;
  const accessToken = async () => {
    const t = await o.tokens(force);
    force = false;
    return t;
  };
  return async function call<T>(url: string): Promise<T> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await http(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
      } catch (e) {
        if (e instanceof GoogleError) throw e;
        res = null; // the network failed: treated like a 503
      }
      if (res?.ok) return (await res.json()) as T;
      const status = res?.status ?? 503;
      if (status === 401 && !refreshed) {
        refreshed = true;
        force = true;
        attempt--;
        continue;
      }
      const body = res ? ((await res.json().catch(() => ({}))) as GoogleErrorBody) : {};
      const reasons = reasonsOf(body);
      const rate =
        status === 429 ||
        body.error?.status === "RESOURCE_EXHAUSTED" ||
        reasons.some((r) => RATE_REASONS.has(r));
      if ((rate || status >= 500) && attempt < RETRIES.length) {
        await sleep(RETRIES[attempt]!);
        continue;
      }
      const message = body.error?.message ?? `Google answered ${status}.`;
      if (rate) throw new GoogleError("rate", message);
      if (reasons.some((r) => SETUP_REASONS.has(r))) throw new GoogleError("setup", message);
      if (status >= 500) throw new GoogleError("unavailable", message);
      if (status === 404) throw new GoogleError("not_found", message);
      if (status === 410) throw new GoogleError("gone", message);
      if (status === 401 || status === 403) throw new GoogleError("access", message);
      throw new GoogleError("bad_request", message);
    }
  };
}
