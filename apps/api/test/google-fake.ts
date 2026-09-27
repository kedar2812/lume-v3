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
export type FakeTab = { sheetId: number; title: string; rows: string[][] };
export type FakeSpreadsheet = { title: string; tabs: FakeTab[]; sharedWith: string[] };
export type GoogleFake = {
  url: string;
  email: string;
  /** The service-account key file, base64, as GOOGLE_SERVICE_ACCOUNT_JSON holds it. */
  env: string;
  put(id: string, s: FakeSpreadsheet): void;
  append(id: string, tab: string, rows: string[][]): void;
  setRows(id: string, tab: string, rows: string[][]): void;
  renameTab(id: string, from: string, to: string): void;
  unshare(id: string): void;
  share(id: string): void;
  remove(id: string): void;
  /** The next `count` Google calls (not the token) answer with this HTTP status. */
  fail(status: number, count?: number): void;
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
  const calls: string[] = [];
  let clock = Date.parse("2026-09-27T00:00:00Z");
  let failing: { status: number; left: number } | null = null;
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
  const parseRange = (r: string) => {
    const m = /^'((?:[^']|'')*)'!(\d+):(\d+)$/.exec(r);
    if (!m) return null;
    return { tab: m[1]!.replace(/''/g, "'"), from: Number(m[2]), to: Number(m[3]) };
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
        api.fail(Number(body.status), Number(body.count ?? 1));
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
    if (!tokens.has((req.headers.authorization ?? "").replace(/^Bearer /, "")))
      return googleError(res, 401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
    if (failing && failing.left > 0) {
      failing.left--;
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
      if (!s || !s.sharedWith.includes(EMAIL)) return googleError(res, 404, "NOT_FOUND", "File not found.");
      return send(res, 200, { modifiedTime: new Date(s.modified).toISOString() });
    }
    const meta = /^\/v4\/spreadsheets\/([^/:]+)$/.exec(u.pathname);
    const values = /^\/v4\/spreadsheets\/([^/:]+)\/values:batchGet$/.exec(u.pathname);
    const id = decodeURIComponent((meta ?? values)?.[1] ?? "");
    const s = sheets.get(id);
    if (!meta && !values) return googleError(res, 404, "NOT_FOUND", "Unknown path.");
    if (!s) return googleError(res, 404, "NOT_FOUND", "Requested entity was not found.");
    if (!s.sharedWith.includes(EMAIL))
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
      const rows = trimmed(tab.rows.slice(p.from - 1, p.to));
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
    fail(status, count = 1) {
      failing = { status, left: count };
    },
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return api;
}
