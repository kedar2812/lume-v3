import { describe, expect, it } from "vitest";
import { boardKeys } from "./boardKeys";

describe("board keyboard moves", () => {
  it("picks up with Space, moves with the arrows inside the board, and drops with Enter", () => {
    let s = boardKeys({ picked: null }, { type: "pick", leadId: "l1", column: 1 });
    expect(s.picked).toEqual({ leadId: "l1", from: 1, to: 1 });
    s = boardKeys(s, { type: "right", columns: 3 });
    s = boardKeys(s, { type: "right", columns: 3 });
    s = boardKeys(s, { type: "right", columns: 3 }); // already at the last column
    expect(s.picked?.to).toBe(2);
    s = boardKeys(s, { type: "left" });
    s = boardKeys(s, { type: "left" });
    s = boardKeys(s, { type: "left" }); // already at the first column
    expect(s.picked?.to).toBe(0);
    expect(boardKeys(s, { type: "drop" }).picked).toBeNull();
  });

  it("Escape puts it back, and arrows without a picked card do nothing", () => {
    const s = boardKeys({ picked: { leadId: "l1", from: 1, to: 2 } }, { type: "cancel" });
    expect(s.picked).toBeNull();
    expect(boardKeys({ picked: null }, { type: "right", columns: 3 })).toEqual({ picked: null });
  });
});
