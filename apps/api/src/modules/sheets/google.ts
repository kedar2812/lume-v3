import { createSign } from "node:crypto";

/** The key file Google issues for a service account, as LUME needs it. */
export type ServiceAccount = { clientEmail: string; privateKey: string; tokenUri: string };
export type SheetTab = { sheetId: number; title: string; rowCount: number };
export type SpreadsheetMeta = { title: string; tabs: SheetTab[] };
export type GoogleErrorKind = "access" | "not_found" | "rate" | "unavailable" | "bad_request";

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
  /** Each A1 range's rows as Google formats them: trailing empty cells and rows are left out. */
  values(spreadsheetId: string, ranges: string[]): Promise<string[][][]>;
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
export const rowsRange = (tab: string, from: number, to: number): string =>
  `'${tab.replace(/'/g, "''")}'!${from}:${to}`;

const b64url = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");

export function createGoogleSheets(o: {
  account: ServiceAccount;
  endpoint?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): GoogleSheets {
  const http = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const sheetsBase = o.endpoint ?? "https://sheets.googleapis.com";
  const driveBase = o.endpoint ?? "https://www.googleapis.com";
  let token: { value: string; until: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && now() < token.until) return token.value;
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
    if (!res.ok) throw new GoogleError("access", "Google refused LUME's service-account key.");
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, until: now() + (j.expires_in - 60) * 1000 };
    return token.value;
  }

  async function call<T>(url: string): Promise<T> {
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
        token = null;
        attempt--;
        continue;
      }
      if ((status === 429 || status >= 500) && attempt < RETRIES.length) {
        await sleep(RETRIES[attempt]!);
        continue;
      }
      const body = res
        ? ((await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } })
        : {};
      const message = body.error?.message ?? `Google answered ${status}.`;
      if (status === 429 || body.error?.status === "RESOURCE_EXHAUSTED")
        throw new GoogleError("rate", message);
      if (status >= 500) throw new GoogleError("unavailable", message);
      if (status === 404) throw new GoogleError("not_found", message);
      if (status === 401 || status === 403) throw new GoogleError("access", message);
      throw new GoogleError("bad_request", message);
    }
  }

  const enc = encodeURIComponent;
  return {
    email: o.account.clientEmail,
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
    async values(id, ranges) {
      const qs = ranges.map((r) => `ranges=${enc(r)}`).join("&");
      const j = await call<{ valueRanges?: { values?: unknown[][] }[] }>(
        `${sheetsBase}/v4/spreadsheets/${enc(id)}/values:batchGet?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&${qs}`,
      );
      return ranges.map((_, i) =>
        (j.valueRanges?.[i]?.values ?? []).map((row) => row.map((c) => String(c ?? ""))),
      );
    },
  };
}
