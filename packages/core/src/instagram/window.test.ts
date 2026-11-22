import { describe, expect, it } from "vitest";
import { instagramWindow, privateReplyOpen } from "./window";

/** Meta's messaging window (NEW_FEATURES_PLAN §4.4): read on Meta's pages 2026-11-22. */
const H = 3_600_000;
const D = 24 * H;
const t0 = new Date("2026-11-22T06:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

describe("instagramWindow", () => {
  it("is open for 24 hours after the person's last message", () => {
    expect(instagramWindow({ lastInAt: t0, adWindowUntil: null }, at(D - 60_000))).toEqual({
      state: "open",
      until: at(D),
    });
    expect(instagramWindow({ lastInAt: t0, adWindowUntil: null }, at(D - 1)).state).toBe("open");
  });

  it("then lets only a person reply, until 7 days after it", () => {
    expect(instagramWindow({ lastInAt: t0, adWindowUntil: null }, at(D))).toEqual({
      state: "human",
      until: at(7 * D),
    });
    expect(instagramWindow({ lastInAt: t0, adWindowUntil: null }, at(7 * D - 1)).state).toBe("human");
  });

  it("is closed from 7 days on, and says since when", () => {
    expect(instagramWindow({ lastInAt: t0, adWindowUntil: null }, at(7 * D))).toEqual({
      state: "closed",
      since: at(7 * D),
    });
  });

  it("is closed, since never, for someone who never wrote", () => {
    expect(instagramWindow({ lastInAt: null, adWindowUntil: null }, t0)).toEqual({
      state: "closed",
      since: null,
    });
  });

  it("stays open up to 7 days after a first message from an ad click", () => {
    const ad = { lastInAt: t0, adWindowUntil: at(7 * D) };
    expect(instagramWindow(ad, at(3 * D))).toEqual({ state: "open", until: at(7 * D) });
    expect(instagramWindow(ad, at(7 * D)).state).toBe("closed");
  });

  it("takes the later of the two when the person also wrote again", () => {
    const w = instagramWindow({ lastInAt: at(6 * D + 20 * H), adWindowUntil: at(7 * D) }, at(6 * D + 22 * H));
    expect(w).toEqual({ state: "open", until: at(7 * D + 20 * H) });
  });

  it("ignores an ad window that's already over", () => {
    expect(instagramWindow({ lastInAt: t0, adWindowUntil: at(-1) }, at(H))).toEqual({
      state: "open",
      until: at(D),
    });
  });

  it("a last message in the future (a skewed clock) counts as now: open", () => {
    expect(instagramWindow({ lastInAt: at(5 * 60_000), adWindowUntil: null }, t0).state).toBe("open");
  });
});

describe("privateReplyOpen", () => {
  it("allows one private reply within 7 days of the comment", () => {
    expect(privateReplyOpen({ at: t0, privateReply: "none" }, at(7 * D - 1))).toBe(true);
    expect(privateReplyOpen({ at: t0, privateReply: "none" }, at(7 * D))).toBe(false);
  });
  it("never a second one; a failed one may be tried again in time", () => {
    expect(privateReplyOpen({ at: t0, privateReply: "sent" }, at(H))).toBe(false);
    expect(privateReplyOpen({ at: t0, privateReply: "queued" }, at(H))).toBe(false);
    expect(privateReplyOpen({ at: t0, privateReply: "failed" }, at(H))).toBe(true);
    expect(privateReplyOpen({ at: t0, privateReply: "failed" }, at(8 * D))).toBe(false);
  });
});
