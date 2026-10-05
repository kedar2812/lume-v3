import { describe, expect, it } from "vitest";
import { trend } from "@lume/core/shared";
import type { Tile } from "./client";
import { headline, minutes, money, repLine, shown } from "./words";

const t = (
  id: Tile["id"],
  value: number,
  previous: number,
  kind: "pct" | "pts" = "pct",
  good: "up" | "down" = "up",
): Tile => ({
  id,
  value,
  previous,
  trend: trend(value, previous, { kind, good }),
});

describe("analytics words (8C)", () => {
  it("shows each unit its own way", () => {
    expect(shown({ id: "new_leads", value: 3810 }, "INR").v).toBe("3,810");
    expect(shown({ id: "win_rate", value: 0.061 }, "INR").v).toBe("6.1%");
    expect(shown({ id: "contacted", value: 0.86 }, "INR").v).toBe("86%");
    expect(shown({ id: "speed_to_lead", value: 14 }, "INR")).toEqual({ v: "14", unit: "min" });
    expect(shown({ id: "revenue_won", value: 9_800_000 }, "AED").v).toMatch(/^AED\s?9\.8M$/);
    expect(shown({ id: "won", value: null }, "AED").v).toBe("—");
    expect(minutes(150)).toBe("2 h 30 min");
    expect(money(950, "USD")).toBe("$950");
  });

  it("rupees read in lakh and crore, the way India reads money (8D spec global constraints)", () => {
    expect(money(5_840_000, "INR")).toBe("₹58.4L");
    expect(money(62_000_000, "INR")).toBe("₹6.2Cr");
    expect(money(20_000_000, "INR")).toBe("₹2Cr");
    expect(money(64_000, "INR")).toBe("₹64K");
    expect(money(6_400_000, "INR", false)).toBe("₹64,00,000");
    expect(money(48_600, "AED")).toMatch(/^AED\s?48\.6K$/);
  });

  it("the headline weighs the good moves against the bad, leads with the biggest, and names the other side", () => {
    const good = headline(
      [t("reply_rate", 0.41, 0.33, "pts"), t("new_leads", 420, 400), t("won", 25, 26)],
      "month",
    );
    expect(good.title).toBe("A good month. Replies are up.");
    const mixed = headline(
      [t("reply_rate", 0.41, 0.33, "pts"), t("new_leads", 380, 400), t("won", 20, 26)],
      "month",
    );
    expect(mixed.title).toBe("A harder month. Wins are down.");
    expect(mixed.sub).toBe("380 new leads and 20 won. Replies are up.");
  });

  it("more bad than good is a harder week; nothing moving is steady", () => {
    expect(
      headline([t("won", 5, 9), t("ontime", 0.7, 0.9, "pts"), t("new_leads", 120, 100)], "week").title,
    ).toBe("A harder week. Wins are down.");
    expect(headline([t("new_leads", 101, 100)], "month").title).toBe("A steady month.");
    expect(headline([{ id: "new_leads", value: 0, previous: null, trend: null }], "day").title).toBe(
      "A quiet day.",
    );
  });

  it("8D spec §5: under 30 new leads it's early days — no trend claims on thin data", () => {
    const h = headline([t("new_leads", 8, 2), t("won", 0, 1)], "month");
    expect(h).toEqual({
      title: "Early days.",
      sub: "8 new leads and 0 won. Trends start to mean something from about 30 leads.",
    });
    expect(headline([t("new_leads", 30, 10)], "month").title).toBe("A good month. New leads are up.");
  });
});

describe("the rep's own line (canvas Rep)", () => {
  it("says what's ahead and what's behind in plain words, then the follow-ups", () => {
    const tiles = [t("reply_rate", 0.46, 0.43, "pts"), t("won", 9, 7), t("contacted", 0.8, 0.9, "pts")];
    expect(repLine(tiles, 0)).toBe(
      "You’re ahead of the period before on replies and wins; contact is behind. Every follow-up is on time.",
    );
    expect(repLine([t("won", 4, 8)], 3)).toBe("Wins are behind the period before. 3 follow-ups are overdue.");
    expect(repLine([t("won", 8, 8)], 1)).toBe("Much like the period before. 1 follow-up is overdue.");
  });
  it("says nothing about trends while there's too little to go on", () => {
    expect(repLine([t("new_leads", 4, 2), t("won", 2, 1)], 0)).toBe("Every follow-up is on time.");
  });
});
