import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the three Google endpoints LUME calls (spec 2B §11), over real HTTP: the token exchange,
 * Drive's file metadata and Sheets' metadata and values. It behaves as Google does where LUME depends
 * on it:
 * - trailing empty cells and rows are left out;
 * - an unshared file is 403 on Sheets and 404 on Drive;
 * - modifiedTime moves on every change.
 * Tests drive it through its methods; e2e drives it through /__fake/*.
 */
/** A cell as shown (v) and, when it differs, as stored (u): a date's serial number, say. */
export type FakeCell = string | { v: string; u: string };
export type FakeTab = { sheetId: number; title: string; rows: FakeCell[][] };
export type FakeSpreadsheet = { title: string; tabs: FakeTab[]; sharedWith: string[] };
export type GoogleFake = {
  url: string;
  email: string;
  /** The service-account key file, base64, as GOOGLE_SERVICE_ACCOUNT_JSON holds it. */
  env: string;
  put(id: string, s: FakeSpreadsheet): void;
  append(id: string, tab: string, rows: FakeCell[][]): void;
  setRows(id: string, tab: string, rows: FakeCell[][]): void;
  renameTab(id: string, from: string, to: string): void;
  unshare(id: string): void;
  share(id: string): void;
  remove(id: string): void;
  /** Connect with Google (2B-2): the user takes LUME's access away at Google, and gives it back. */
  revokeGrant(): void;
  restoreGrant(): void;
  /** The next `count` Google calls (not the token) answer with this HTTP status (and error reason). */
  fail(status: number, count?: number, reason?: string): void;
  /** Every Google call's method and path, in order ("GET /v4/spreadsheets/abc"). */
  calls: string[];
  close(): Promise<void>;
};

const EMAIL = "lume-sheets@lume-test.iam.gserviceaccount.com";

export async function startGoogleFake(o: { port?: number } = {}): Promise<GoogleFake> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const sheets = new Map<string, FakeSpreadsheet & { modified: number }>();
  const tokens = new Set<string>();
  const oauthTokens = new Set<string>();
  let revoked = false;
  const calls: string[] = [];
  let clock = Date.parse("2026-09-27T00:00:00Z");
  let failing: { status: number; left: number; reason?: string } | null = null;
  let url = "";

  const touch = (id: string) => {
    const s = sheets.get(id);
    if (s) s.modified = clock += 1000;
  };
  const tabOf = (id: string, title: string) => {
    const t = sheets.get(id)?.tabs.find((x) => x.title === title);
    if (!t) throw new Error(`fake: no tab ${title} in ${id}`);
    return t;
  };
  const shown = (c: FakeCell, raw: boolean) => (typeof c === "string" ? c : raw ? c.u : c.v);
  const trimmed = (rows: string[][]) => {
    const out = rows.map((r) => {
      const c = [...r];
      while (c.length && c.at(-1) === "") c.pop();
      return c;
    });
    while (out.length && out.at(-1)!.length === 0) out.pop();
    return out;
  };
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const googleError = (res: http.ServerResponse, code: number, status: string, message: string) =>
    send(res, code, { error: { code, status, message } });
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c: Buffer) => (b += c.toString("utf8")));
      req.on("end", () => resolve(b));
    });
  // "'Tab ''x'''!5:104" → { tab: "Tab 'x'", from: 5, to: 104 }
  // …or "'Tab'!C5:C104": one column of those rows.
  const parseRange = (r: string) => {
    const m = /^'((?:[^']|'')*)'!([A-Z]*)(\d+):([A-Z]*)(\d+)$/.exec(r);
    if (!m || m[2] !== m[4]) return null;
    const col = m[2] ? [...m[2]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : null;
    return { tab: m[1]!.replace(/''/g, "'"), from: Number(m[3]), to: Number(m[5]), col };
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://fake");
    // Controls, for e2e (the tests in this repo call the methods directly).
    if (u.pathname.startsWith("/__fake/")) {
      const body =
        req.method === "GET" ? {} : (JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>);
      const [, , what, id, action] = u.pathname.split("/");
      if (what === "key") return send(res, 200, { env: api.env, email: EMAIL });
      if (what === "fail") {
        api.fail(Number(body.status), Number(body.count ?? 1), body.reason ? String(body.reason) : undefined);
        return send(res, 200, {});
      }
      if (what === "spreadsheets" && id) {
        if (!action) api.put(id, body as unknown as FakeSpreadsheet);
        else if (action === "append") api.append(id, String(body.tab), body.rows as string[][]);
        else if (action === "rows") api.setRows(id, String(body.tab), body.rows as string[][]);
        else if (action === "unshare") api.unshare(id);
        else if (action === "share") api.share(id);
        return send(res, 200, {});
      }
      return send(res, 404, {});
    }
    if (u.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      // OAuth (the relay, 2B-2): "good-code" signs in; "rt-good" refreshes until the grant is revoked. A
      // token from a grant reads any sheet, as drive.file lets a picked file through.
      const grant = form.get("grant_type");
      if (grant === "authorization_code" || grant === "refresh_token") {
        const good =
          grant === "authorization_code"
            ? form.get("code") === "good-code"
            : form.get("refresh_token") === "rt-good" && !revoked;
        if (!good) return send(res, 400, { error: "invalid_grant" });
        const token = randomBytes(16).toString("hex");
        tokens.add(token);
        oauthTokens.add(token);
        return send(res, 200, {
          access_token: token,
          expires_in: 3600,
          token_type: "Bearer",
          ...(grant === "authorization_code" ? { refresh_token: "rt-good" } : {}),
        });
      }
      const [h, c, sig] = (form.get("assertion") ?? "").split(".");
      const ok =
        !!h &&
        !!c &&
        !!sig &&
        verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, "base64url"));
      const claims = ok
        ? (JSON.parse(Buffer.from(c!, "base64url").toString("utf8")) as { iss?: string })
        : {};
      if (!ok || claims.iss !== EMAIL) return send(res, 400, { error: "invalid_grant" });
      const token = randomBytes(16).toString("hex");
      tokens.add(token);
      return send(res, 200, { access_token: token, expires_in: 3600, token_type: "Bearer" });
    }
    calls.push(`${req.method} ${u.pathname}`);
    const viaGrant = oauthTokens.has((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!tokens.has((req.headers.authorization ?? "").replace(/^Bearer /, "")))
      return googleError(res, 401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
    if (failing && failing.left > 0) {
      failing.left--;
      if (failing.reason)
        return send(res, failing.status, {
          error: {
            code: failing.status,
            message: `fake ${failing.reason}`,
            errors: [{ reason: failing.reason }],
          },
        });
      return googleError(
        res,
        failing.status,
        failing.status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE",
        "fake failure",
      );
    }
    const drive = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (drive) {
      const s = sheets.get(decodeURIComponent(drive[1]!));
      if (!s || (!viaGrant && !s.sharedWith.includes(EMAIL)))
        return googleError(res, 404, "NOT_FOUND", "File not found.");
      return send(res, 200, { modifiedTime: new Date(s.modified).toISOString() });
    }
    const meta = /^\/v4\/spreadsheets\/([^/:]+)$/.exec(u.pathname);
    const values = /^\/v4\/spreadsheets\/([^/:]+)\/values:batchGet$/.exec(u.pathname);
    const id = decodeURIComponent((meta ?? values)?.[1] ?? "");
    const s = sheets.get(id);
    if (!meta && !values) return googleError(res, 404, "NOT_FOUND", "Unknown path.");
    if (!s) return googleError(res, 404, "NOT_FOUND", "Requested entity was not found.");
    if (!viaGrant && !s.sharedWith.includes(EMAIL))
      return googleError(res, 403, "PERMISSION_DENIED", "The caller does not have permission");
    if (meta)
      return send(res, 200, {
        properties: { title: s.title },
        sheets: s.tabs.map((t) => ({
          properties: {
            sheetId: t.sheetId,
            title: t.title,
            gridProperties: { rowCount: Math.max(1000, t.rows.length) },
          },
        })),
      });
    const valueRanges = [];
    for (const r of u.searchParams.getAll("ranges")) {
      const p = parseRange(r);
      const tab = p && s.tabs.find((t) => t.title === p.tab);
      if (!p || !tab) return googleError(res, 400, "INVALID_ARGUMENT", `Unable to parse range: ${r}`);
      const raw = u.searchParams.get("valueRenderOption") === "UNFORMATTED_VALUE";
      const rows = trimmed(
        tab.rows
          .slice(p.from - 1, p.to)
          .map((row) => (p.col === null ? row : row.slice(p.col, p.col + 1)).map((c) => shown(c, raw))),
      );
      valueRanges.push({ range: r, majorDimension: "ROWS", ...(rows.length ? { values: rows } : {}) });
    }
    return send(res, 200, { spreadsheetId: id, valueRanges });
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const api: GoogleFake = {
    url,
    email: EMAIL,
    env: Buffer.from(
      JSON.stringify({
        type: "service_account",
        client_email: EMAIL,
        private_key: pem,
        token_uri: `${url}/token`,
      }),
    ).toString("base64"),
    put(id, s) {
      sheets.set(id, { ...structuredClone(s), modified: (clock += 1000) });
    },
    append(id, tab, rows) {
      tabOf(id, tab).rows.push(...structuredClone(rows));
      touch(id);
    },
    setRows(id, tab, rows) {
      tabOf(id, tab).rows = structuredClone(rows);
      touch(id);
    },
    renameTab(id, from, to) {
      tabOf(id, from).title = to;
      touch(id);
    },
    unshare(id) {
      const s = sheets.get(id);
      if (s) s.sharedWith = s.sharedWith.filter((e) => e !== EMAIL);
    },
    share(id) {
      const s = sheets.get(id);
      if (s && !s.sharedWith.includes(EMAIL)) s.sharedWith.push(EMAIL);
    },
    remove(id) {
      sheets.delete(id);
    },
    revokeGrant() {
      // As Google does: removing access also ends the access tokens already given out.
      revoked = true;
      for (const tok of oauthTokens) tokens.delete(tok);
      oauthTokens.clear();
    },
    restoreGrant() {
      revoked = false;
    },
    fail(status, count = 1, reason) {
      failing = { status, left: count, ...(reason ? { reason } : {}) };
    },
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return api;
}
