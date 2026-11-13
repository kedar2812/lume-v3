import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGoogleFake, type GoogleFake } from "../../../test/google-fake";
import {
  GoogleError,
  createGoogleSheets,
  googleCaller,
  relayTokens,
  isTransient,
  parseServiceAccount,
  parseSheetLink,
  rowsRange,
  type GoogleSheets,
} from "./google";

let fake: GoogleFake;
let g: GoogleSheets;
const slept: number[] = [];
beforeAll(async () => {
  fake = await startGoogleFake();
  g = createGoogleSheets({
    account: parseServiceAccount(fake.env)!,
    endpoint: fake.url,
    sleep: async (ms) => void slept.push(ms),
  });
  fake.put("s1", {
    title: "Website enquiries",
    sharedWith: [fake.email],
    tabs: [
      {
        sheetId: 0,
        title: "Form responses",
        rows: [["Name", "Phone"], ["Aisha Khan", "0501234567", ""], [], ["Omar", "0502223333"]],
      },
      { sheetId: 77, title: "Q3 'West'", rows: [["Name"], ["Lina"]] },
    ],
  });
});
afterAll(() => fake.close());

describe("the Google client", () => {
  it("reads the spreadsheet's tabs, by id and title", async () => {
    expect(await g.spreadsheet("s1")).toEqual({
      title: "Website enquiries",
      tabs: [
        { sheetId: 0, title: "Form responses", rowCount: 1000 },
        { sheetId: 77, title: "Q3 'West'", rowCount: 1000 },
      ],
    });
    expect(g.email).toBe(fake.email);
  });

  it("reads several ranges in one call, as Google formats them (trailing blanks left out)", async () => {
    const [head, body, west] = await g.values("s1", [
      rowsRange("Form responses", 1, 1),
      rowsRange("Form responses", 2, 5001),
      rowsRange("Q3 'West'", 2, 2),
    ]);
    expect(head).toEqual([["Name", "Phone"]]);
    expect(body).toEqual([["Aisha Khan", "0501234567"], [], ["Omar", "0502223333"]]);
    expect(west).toEqual([["Lina"]]);
  });

  it("modifiedTime moves when the sheet changes; the token is fetched once and reused", async () => {
    const before = await g.modifiedTime("s1");
    fake.append("s1", "Form responses", [["Zoe", "0504445555"]]);
    const after = await g.modifiedTime("s1");
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it("an unshared sheet is an access error; a missing one is not_found", async () => {
    fake.put("private", { title: "P", sharedWith: [], tabs: [{ sheetId: 0, title: "A", rows: [["x"]] }] });
    await expect(g.spreadsheet("private")).rejects.toMatchObject({ kind: "access" });
    await expect(g.modifiedTime("private")).rejects.toMatchObject({ kind: "not_found" });
    await expect(g.spreadsheet("nope")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("retries 429 and 5xx with backoff, then gives up as rate or unavailable (transient)", async () => {
    slept.length = 0;
    fake.fail(429, 2);
    await expect(g.spreadsheet("s1")).resolves.toMatchObject({ title: "Website enquiries" });
    expect(slept).toEqual([1000, 2000]);
    fake.fail(503, 4);
    const e = await g.spreadsheet("s1").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GoogleError);
    expect((e as GoogleError).kind).toBe("unavailable");
    expect(isTransient(e)).toBe(true);
    expect(isTransient(new GoogleError("access", "x"))).toBe(false);
  });

  it("Drive's 403 rate limits are retried and then passing; a disabled API is a setup problem, not lost access", async () => {
    slept.length = 0;
    fake.fail(403, 2, "userRateLimitExceeded");
    await expect(g.modifiedTime("s1")).resolves.toBeTruthy();
    expect(slept).toEqual([1000, 2000]);
    fake.fail(403, 4, "rateLimitExceeded");
    await expect(g.modifiedTime("s1")).rejects.toMatchObject({ kind: "rate" });
    fake.fail(403, 1, "accessNotConfigured");
    await expect(g.spreadsheet("s1")).rejects.toMatchObject({ kind: "setup" });
    fake.fail(403, 0);
  });

  it("a broken key is a setup problem, not retried forever", async () => {
    const bad = createGoogleSheets({
      account: { ...parseServiceAccount(fake.env)!, clientEmail: "someone-else@x.iam.gserviceaccount.com" },
      endpoint: fake.url,
      sleep: async () => undefined,
    });
    await expect(bad.spreadsheet("s1")).rejects.toMatchObject({ kind: "setup" });
  });
});

describe("links and ranges", () => {
  it("parses a sheet's link, its gid, or a bare id", () => {
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=77`)).toEqual({
      spreadsheetId: id,
      gid: 77,
    });
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing&gid=0`)).toEqual({
      spreadsheetId: id,
      gid: 0,
    });
    expect(parseSheetLink(`  ${id}  `)).toEqual({ spreadsheetId: id, gid: null });
    expect(parseSheetLink("https://example.com/not-a-sheet")).toBeNull();
    expect(parseSheetLink("")).toBeNull();
  });
  it("quotes a tab title, doubling its apostrophes", () => {
    expect(rowsRange("Q3 'West'", 5, 104)).toBe("'Q3 ''West'''!5:104");
  });
  it("parseServiceAccount reads the key file, or returns null", () => {
    expect(parseServiceAccount(undefined)).toBeNull();
    expect(parseServiceAccount("not base64 json")).toBeNull();
    expect(parseServiceAccount(fake.env)).toMatchObject({
      clientEmail: fake.email,
      tokenUri: `${fake.url}/token`,
    });
  });
});

describe("Google not answering (night QA 2026-11-13)", () => {
  /** A Google that takes the call and never answers, until LUME gives up on it. */
  const hung = (tries: string[]) =>
    ((url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        tries.push(url);
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;

  it("each try gives up after its time and is tried again, then it's unavailable: never a request held for minutes", async () => {
    const tries: string[] = [];
    const call = googleCaller({
      tokens: async () => "t",
      fetch: hung(tries),
      sleep: async () => {},
      timeoutMs: 20,
    });
    await expect(call("https://google.test/x")).rejects.toMatchObject({ kind: "unavailable" });
    expect(tries).toHaveLength(4); // the first try and three more
  });

  it("a write that mustn't be repeated gives up after one try", async () => {
    const tries: string[] = [];
    const call = googleCaller({
      tokens: async () => "t",
      fetch: hung(tries),
      sleep: async () => {},
      timeoutMs: 20,
    });
    await expect(
      call("https://google.test/x", { method: "POST", body: {}, retry: false }),
    ).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(tries).toHaveLength(1);
  });

  it("an answer that stops arriving halfway is unavailable too, never a stray error", async () => {
    const cut = (async () => {
      const r = new Response("{", { status: 200 });
      Object.defineProperty(r, "json", {
        value: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      });
      return r;
    }) as unknown as typeof fetch;
    const call = googleCaller({ tokens: async () => "t", fetch: cut, sleep: async () => {}, timeoutMs: 20 });
    await expect(call("https://google.test/x")).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("the connector handing out access gives up too", async () => {
    const tokens = relayTokens({
      relayUrl: "https://relay.test",
      relayToken: "r",
      refreshToken: "g",
      fetch: hung([]),
      timeoutMs: 20,
    });
    await expect(tokens()).rejects.toMatchObject({ kind: "unavailable" });
  });
});
