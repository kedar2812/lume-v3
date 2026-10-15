import { describe, expect, it } from "vitest";
import { canonicalKey, displayKey, keyChars } from "./product-key";
import { activateBody, checkBody } from "./token";

const ISSUED = "LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K";
const INSTALL = "0190e0c0-0000-7000-8000-000000000001";

describe("the product key's one spelling (spec 2026-10-15 §1.1)", () => {
  it.each([
    ISSUED,
    "lume-7k2p-q9xd-4mrt-h8vc-7q2k",
    "7K2PQ9XD4MRTH8VC7Q2K",
    " LUME 7K2P Q9XD 4MRT H8VC 7Q2K ",
    "LUME–7K2P–Q9XD–4MRT–H8VC–7Q2K", // en-dashes, as a chat app pastes them
  ])("%s is the issued key", (typed) => expect(canonicalKey(typed)).toBe(ISSUED));

  it("reads O as 0 and I or L as 1 (Crockford), and never invents a U", () => {
    expect(keyChars("LUME-O1IL")).toBe("0111");
    expect(keyChars("UUUU")).toBe("");
  });

  it("is null until all five groups are there, and stops at five", () => {
    expect(canonicalKey("LUME-7K2P-Q9XD")).toBeNull();
    expect(canonicalKey("")).toBeNull();
    expect(canonicalKey(`${ISSUED}ZZZZ`)).toBe(ISSUED);
  });

  it("groups as the person types", () => {
    expect(displayKey("")).toBe("");
    expect(displayKey("7k2pq")).toBe("LUME-7K2P-Q");
    expect(displayKey(ISSUED)).toBe(ISSUED);
  });
});

describe("what goes to the licence server", () => {
  const now = new Date("2026-10-15T09:00:00Z");

  it("a check carries this install's id, and nothing about a lead", () => {
    const body = checkBody({
      instanceId: "LUME-AAAA-BBBB",
      licenseKey: ISSUED,
      installId: INSTALL,
      appVersion: "1.4.2",
      activeUserCount: 3,
      leadCount: 9,
      now,
    });
    expect(Object.keys(body).sort()).toEqual([
      "activeUserCount",
      "appVersion",
      "installId",
      "instanceId",
      "leadCount",
      "licenseKey",
      "serverTime",
    ]);
    expect(body.installId).toBe(INSTALL);
  });

  it("an activation carries the key, the install's id, the version and the clock — only", () => {
    expect(activateBody({ licenseKey: ISSUED, installId: INSTALL, appVersion: "1.4.2", now })).toEqual({
      licenseKey: ISSUED,
      installId: INSTALL,
      appVersion: "1.4.2",
      serverTime: "2026-10-15T09:00:00.000Z",
    });
  });
});
