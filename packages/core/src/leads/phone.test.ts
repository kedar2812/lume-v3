import { describe, expect, it } from "vitest";
import { dialCountries, joinPhone, splitPhone } from "./phone";

describe("dialCountries", () => {
  it("lists every country once with its calling code", () => {
    const all = dialCountries();
    expect(all.length).toBeGreaterThan(200);
    expect(all).toContainEqual({ iso: "AE", code: "971" });
    expect(all).toContainEqual({ iso: "IN", code: "91" });
    expect(new Set(all.map((c) => c.iso)).size).toBe(all.length);
  });
});

describe("splitPhone", () => {
  it("reads the country from an international number, leaving the national part", () => {
    expect(splitPhone("+971501234567", "IN")).toEqual({ country: "AE", national: "501234567" });
    expect(splitPhone("+91 98200 12345", "AE")).toEqual({ country: "IN", national: "9820012345" });
  });

  it("uses the business country for a number without one, and for nothing at all", () => {
    expect(splitPhone("050 123 4567", "AE")).toEqual({ country: "AE", national: "050 123 4567" });
    expect(splitPhone("", "AE")).toEqual({ country: "AE", national: "" });
    expect(splitPhone(null, null)).toEqual({ country: null, national: "" });
  });

  it("still finds the country of an international number that isn't valid yet", () => {
    expect(splitPhone("+97150", "IN")).toEqual({ country: "AE", national: "50" });
  });
});

describe("joinPhone", () => {
  it("puts the chosen country's code in front, dropping a typed trunk zero", () => {
    expect(joinPhone("AE", "050 123 4567")).toBe("+971501234567");
    expect(joinPhone("AE", "50 123 4567")).toBe("+971501234567");
    expect(joinPhone("IN", "98200 12345")).toBe("+919820012345");
  });

  it("keeps a number that isn't valid as typed, behind the code, for the server to judge", () => {
    expect(joinPhone("AE", "12")).toBe("+971 12");
  });

  it("leaves an empty number empty, and a pasted international number as it is", () => {
    expect(joinPhone("AE", "  ")).toBe("");
    expect(joinPhone("AE", "+44 20 7946 0958")).toBe("+44 20 7946 0958");
    expect(joinPhone(null, "050 123 4567")).toBe("050 123 4567");
  });
});
