import { describe, expect, it, vi } from "vitest";
import { fixedRates, openErApi } from "./rates";

describe("openErApi", () => {
  it("reads one rate and its date from the provider's answer", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: "success",
            time_last_update_utc: "Thu, 25 Sep 2026 00:02:31 +0000",
            rates: { USD: 0.2723 },
          }),
        ),
    );
    expect(await openErApi(fetchImpl as unknown as typeof fetch).quote("AED", "USD")).toEqual({
      rate: 0.2723,
      asOf: "2026-09-25T00:02:31.000Z",
      source: "open.er-api.com",
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://open.er-api.com/v6/latest/AED", expect.anything());
  });

  it("fails plainly when the provider has no rate or can't be reached", async () => {
    const empty = vi.fn(async () => new Response(JSON.stringify({ result: "error" })));
    await expect(openErApi(empty as unknown as typeof fetch).quote("AED", "USD")).rejects.toThrow("no rate");
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(openErApi(down as unknown as typeof fetch).quote("AED", "USD")).rejects.toThrow();
  });
});

describe("fixedRates", () => {
  it("answers from a table, both ways", async () => {
    const r = fixedRates("AED:USD=0.27");
    expect((await r.quote("AED", "USD")).rate).toBe(0.27);
    expect((await r.quote("USD", "AED")).rate).toBeCloseTo(1 / 0.27, 6);
    await expect(r.quote("AED", "INR")).rejects.toThrow("no rate");
  });
});
