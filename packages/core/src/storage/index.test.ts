import { describe, expect, it } from "vitest";
import { storageCount, storageSize } from "./index";

describe("Storage's sizes and counts", () => {
  it("megabytes below a gigabyte, one decimal from there; nothing odd for odd input", () => {
    expect(storageSize(0)).toBe("0 MB");
    expect(storageSize(-5)).toBe("0 MB");
    expect(storageSize(Number.NaN)).toBe("0 MB");
    expect(storageSize(1000)).toBe("1 MB");
    expect(storageSize(830 * 2 ** 20)).toBe("830 MB");
    expect(storageSize(1023.8 * 2 ** 20)).toBe("1.0 GB");
    expect(storageSize(20.74 * 2 ** 30)).toBe("20.7 GB");
    expect(storageSize(99.94 * 2 ** 30)).toBe("99.9 GB");
    expect(storageSize(100 * 2 ** 30)).toBe("100 GB");
    expect(storageSize(512.4 * 2 ** 30)).toBe("512 GB");
    expect(storageSize(1536 * 2 ** 30)).toBe("1.5 TB");
  });

  it("counts in Indian grouping", () => {
    expect(storageCount(12410)).toBe("12,410");
    expect(storageCount(1234567)).toBe("12,34,567");
    expect(storageCount(-3)).toBe("0");
  });
});
