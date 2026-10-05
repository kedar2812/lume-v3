import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Quality, Templates } from "@/lib/analytics/client";
import { QualityBoard } from "./QualityBoard";

const quality = (o: Partial<Quality> = {}): Quality => ({
  range: { label: "Last 30 days", days: [] },
  phones: {
    total: 1000,
    readable: 978,
    readableShare: 0.978,
    needsCountry: 12,
    invalid: 10,
    drill: { needsCountry: "d-nc", invalid: "d-inv" },
  },
  duplicatesMerged: 148,
  phoneNeedsCountry: 12,
  phoneInvalid: 10,
  unowned: {
    under1h: 3,
    under1d: 2,
    under7d: 1,
    over7d: 0,
    over1d: 1,
    oldestMinutes: 125,
    drill: { under_1h: "d-1h", under_1d: "d-1d", under_7d: "d-7d" },
  },
  imports: [{ sourceId: "s1", name: "CSV import", rows: 2400, rejected: 9 }],
  importsRejected: [],
  sourcesNeedingLook: [
    {
      id: "s2",
      name: "Webinar sheet",
      type: "google_sheet",
      status: "paused",
      message: "A column was renamed",
    },
  ],
  ...o,
});
const templates: Templates = {
  range: { label: "Last 30 days", days: [] },
  templates: [
    { id: "t1", name: "First hello", sends: 200, replies: 80, wins: 9, replyRate: 0.4, tooFew: false },
    { id: "t2", name: "Day-3 nudge", sends: 120, replies: 24, wins: 3, replyRate: 0.2, tooFew: false },
    { id: "t3", name: "Rare one", sends: 4, replies: 1, wins: 0, replyRate: 0.25, tooFew: true },
  ],
};
const props = { templates, rangeWords: "in the last 30 days" };

describe("Templates & data (canvas Quality)", () => {
  it("templates: sent, replies with the best in green, reply rate, wins; a thin one says too few", () => {
    render(<QualityBoard quality={quality()} {...props} onDrill={vi.fn()} />);
    const rows = within(screen.getByRole("region", { name: "Templates" })).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("First hello2008040%9");
    expect(rows[1]!.querySelector("[data-best]")).not.toBeNull();
    expect(rows[3]).toHaveTextContent("Too few");
  });

  it("numbers LUME can read: the share, and the ones to fix opening their leads", async () => {
    const onDrill = vi.fn();
    render(<QualityBoard quality={quality()} {...props} onDrill={onDrill} />);
    const card = screen.getByRole("region", { name: "Numbers LUME can read" });
    expect(card).toHaveTextContent("97.8%");
    expect(card).toHaveTextContent("Duplicates merged");
    await userEvent.click(within(card).getByRole("button", { name: "Fix: need a country" }));
    expect(onDrill).toHaveBeenCalledWith("d-nc", "Numbers that need a country");
  });

  it("nobody yet: how many, the oldest wait, and each wait opening its leads", async () => {
    const onDrill = vi.fn();
    render(<QualityBoard quality={quality()} {...props} onDrill={onDrill} />);
    expect(screen.getByRole("region", { name: "Nobody yet" })).toHaveTextContent(
      "6The oldest has waited 2 h 5 min",
    );
    const waits = screen.getByRole("region", { name: "Nobody yet, by how long" });
    expect(within(waits).getByRole("button", { name: "Over a week: 0. See the leads." })).toBeDisabled();
    await userEvent.click(within(waits).getByRole("button", { name: "Under 1 hour: 3. See the leads." }));
    expect(onDrill).toHaveBeenCalledWith("d-1h", "Nobody yet: under 1 hour");
  });

  it("sources needing a look and imports that didn't come in cleanly", () => {
    render(<QualityBoard quality={quality()} {...props} onDrill={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Sources needing a look" })).toHaveTextContent(
      "Webinar sheet: A column was renamed",
    );
    const imports = screen.getByRole("region", { name: "Imports and sources" });
    expect(imports).toHaveTextContent("Webinar sheetA column was renamedPaused");
    expect(imports).toHaveTextContent("CSV import2,400 rows9 didn’t come in");
  });

  it("when all is well it says so", () => {
    render(
      <QualityBoard
        quality={quality({ sourcesNeedingLook: [], imports: [] })}
        {...props}
        onDrill={vi.fn()}
      />,
    );
    expect(screen.getByRole("region", { name: "Sources needing a look" })).toHaveTextContent(
      "Every source is bringing leads in",
    );
    expect(screen.getByRole("region", { name: "Imports and sources" })).toHaveTextContent(
      "every source is running",
    );
  });
});
