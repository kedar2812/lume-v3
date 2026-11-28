import { describe, expect, it } from "vitest";
import { keepNode, type Sized } from "./keep-nodes";

/**
 * The builder's cards are React Flow nodes rebuilt from the graph. A card handed over as a new object without its size
 * is measured again by React Flow: hidden, measured, its lines redrawn (owner 2026-11-28: "the cards are laggy"; a
 * probe on 24 steps: every card re-measured on every frame of a drag). So a card that didn't change is the same object,
 * and one that did carries the size React Flow last measured.
 */
type N = Sized & { id: string; position: { x: number; y: number }; data: object; selected: boolean };
const pos = { x: 0, y: 0 };
const data = { node: "a" };
const base = (over: Partial<N> = {}): N => ({ id: "a", position: pos, data, selected: false, ...over });
const same = (a: N, b: N) => a.position === b.position && a.data === b.data && a.selected === b.selected;

describe("keeping a card as it was", () => {
  it("nothing about it changed: the very same object, so React Flow keeps its measure", () => {
    const cache = new Map<string, N>();
    const first = keepNode(cache, base(), same, new Map());
    expect(keepNode(cache, base(), same, new Map())).toBe(first);
  });

  it("moved: a new object, with the size React Flow measured", () => {
    const cache = new Map<string, N>();
    keepNode(cache, base(), same, new Map());
    const moved = keepNode(
      cache,
      base({ position: { x: 5, y: 0 } }),
      same,
      new Map([["a", { width: 240, height: 180 }]]),
    );
    expect(moved.position).toEqual({ x: 5, y: 0 });
    expect(moved.measured).toEqual({ width: 240, height: 180 });
  });

  it("selected: a new object, still with its size (its ways out are as they were)", () => {
    const cache = new Map<string, N>();
    const sizes = new Map([["a", { width: 240, height: 180 }]]);
    const first = keepNode(cache, base(), same, sizes);
    const picked = keepNode(cache, base({ selected: true }), same, sizes);
    expect(picked).not.toBe(first);
    expect(picked.measured).toEqual({ width: 240, height: 180 });
  });

  // Review 2026-11-28: a carried size keeps React Flow's old handle places; a reply swapped at the same height then
  // left its line on a handle that no longer exists. Words changed: React Flow measures the card, handles and all.
  it("its words changed: no size carried, so React Flow measures it and its ways out afresh", () => {
    const cache = new Map<string, N>();
    const sizes = new Map([["a", { width: 240, height: 180 }]]);
    keepNode(cache, base(), same, sizes);
    const edited = keepNode(cache, base({ data: { node: "b" } }), same, sizes);
    expect(edited.measured).toBeUndefined();
  });

  it("never measured yet: no size is made up (React Flow measures it once)", () => {
    const cache = new Map<string, N>();
    expect(keepNode(cache, base(), same, new Map()).measured).toBeUndefined();
  });

  it("a size measured after the card was kept is carried the next time it moves", () => {
    const cache = new Map<string, N>();
    const sizes = new Map<string, { width: number; height: number }>();
    keepNode(cache, base(), same, sizes);
    sizes.set("a", { width: 240, height: 200 });
    expect(keepNode(cache, base({ selected: true }), same, sizes).measured).toEqual({
      width: 240,
      height: 200,
    });
  });
});
