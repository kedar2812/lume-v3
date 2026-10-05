import { describe, expect, it } from "vitest";
import { foldBySource } from "./service";

const days = ["2026-07-01", "2026-07-02"];
const row = (day: string, id: string | null, n: number) => ({
  day,
  source_id: id,
  name: id ? `S ${id}` : null,
  n,
});

describe("new leads by source, folded for the chart", () => {
  it("names the four biggest and puts the rest together, day by day, every lead counted once", () => {
    const rows = [
      row(days[0]!, "a", 10),
      row(days[1]!, "a", 5),
      row(days[0]!, "b", 8),
      row(days[0]!, "c", 6),
      row(days[1]!, "d", 4),
      row(days[0]!, "e", 2),
      row(days[1]!, null, 3),
    ];
    const out = foldBySource(rows, days);
    expect(out.map((x) => x.name)).toEqual(["S a", "S b", "S c", "S d", "2 more sources"]);
    expect(out[0]!.values).toEqual([10, 5]);
    expect(out.at(-1)!.values).toEqual([2, 3]);
    const total = out.reduce((a, x) => a + x.values.reduce((p, v) => p + v, 0), 0);
    expect(total).toBe(rows.reduce((a, r) => a + r.n, 0));
  });

  it("five or fewer are all named; leads added in LUME have a name too", () => {
    const out = foldBySource([row(days[0]!, null, 2), row(days[1]!, "a", 1)], days);
    expect(out.map((x) => x.name)).toEqual(["Added in LUME", "S a"]);
    expect(out[0]!.values).toEqual([2, 0]);
  });
});
