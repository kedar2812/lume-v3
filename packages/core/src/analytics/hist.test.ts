import { describe, expect, it } from "vitest";
import { BUCKETS, addHist, bucketOf, median, quantileFromHist } from "./hist";

describe("duration histograms (8A)", () => {
  it("puts a duration in its bucket, edges belonging to the bucket above", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(4.9)).toBe(0);
    expect(bucketOf(5)).toBe(1);
    expect(bucketOf(59)).toBe(3);
    expect(bucketOf(60)).toBe(4);
    expect(bucketOf(1e9)).toBe(BUCKETS - 1);
  });

  it("reads a median linearly inside its bucket, and nothing from an empty one", () => {
    const h = Array(BUCKETS).fill(0);
    h[4] = 10; // ten contacts between 60 and 120 minutes
    expect(quantileFromHist(h, 0.5)).toBe(90);
    expect(quantileFromHist(h, 0.75)).toBe(105);
    expect(quantileFromHist(Array(BUCKETS).fill(0), 0.5)).toBeNull();
    const open = Array(BUCKETS).fill(0);
    open[BUCKETS - 1] = 3; // over a week: the lower edge, never a made-up figure
    expect(quantileFromHist(open, 0.5)).toBe(10080);
  });

  it("adds histograms, and takes the exact median of a list", () => {
    expect(addHist([1, 2, 3], [1, 1, 1])).toEqual([2, 3, 4]);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
