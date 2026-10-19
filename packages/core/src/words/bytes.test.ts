import { describe, expect, it } from "vitest";
import { bytesText } from "./bytes";

describe("bytesText", () => {
  it("says a size the way people read it: whole numbers from 10 up, one decimal below", () => {
    expect(
      [
        0,
        1,
        1023,
        1024,
        84 * 1024,
        1024 ** 2,
        1.25 * 1024 ** 2,
        640 * 1024 ** 2,
        8.2 * 1024 ** 3,
        61.4 * 1024 ** 3,
        2.5 * 1024 ** 4,
      ].map(bytesText),
    ).toEqual([
      "0 KB",
      "1 KB",
      "1 KB",
      "1 KB",
      "84 KB",
      "1 MB",
      "1.3 MB",
      "640 MB",
      "8.2 GB",
      "61 GB",
      "2.5 TB",
    ]);
  });
  it("a size that rounds up to the next unit says the next unit", () => {
    expect([1023.9 * 1024, 1023.9 * 1024 ** 2, 9.96 * 1024 ** 2].map(bytesText)).toEqual([
      "1 MB",
      "1 GB",
      "10 MB",
    ]);
  });
  it("never says nonsense for a value that isn't a size", () => {
    expect([-5, Number.NaN, Number.POSITIVE_INFINITY].map(bytesText)).toEqual(["0 KB", "0 KB", "0 KB"]);
  });
});
