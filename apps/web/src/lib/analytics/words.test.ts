import { describe, expect, it } from "vitest";
import { trend } from "@lume/core/shared";
import type { Tile } from "./client";
import { headline, minutes, money, shown } from "./words";

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
});
