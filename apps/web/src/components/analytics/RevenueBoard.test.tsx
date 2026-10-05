import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Revenue, Sources } from "@/lib/analytics/client";
import { testCatalog } from "@/lib/leads/test-catalog";
import { RevenueBoard } from "./RevenueBoard";

const SRC = "0190e0c0-0000-7000-8000-00000000c5c5";
const revenue = (o: Partial<Revenue> = {}): Revenue => ({
  range: { label: "Last 30 days", days: [] },
  thisMonth: {
    days: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"],
    cumulative: [1000, 3000, 3000, 9000, 12000, 15000, 20000],
    goal: 100000,
    paceEnd: 88571,
    today: "2026-10-07",
    daysInMonth: 31,
  },
  byMonth: Array.from({ length: 12 }, (_, i) => ({
    month: `2026-${String(i + 1).padStart(2, "0")}`,
    label: "November",
    value: 1000 * (i + 1),
    goal: null,
  })),
  byProduct: [
    { id: "p1", name: "Signature", deals: 12, value: 60000, share: 0.6, drill: "d-p1" },
    { id: null, name: "Won without a package", deals: 8, value: 40000, share: 0.4, drill: "d-none" },
  ],
  fact: { product: "Signature", dealShare: 0.3, revenueShare: 0.6 },
  total: 100000,
  previousTotal: 80000,
  trend: { dir: "up", tone: "good", text: "+25%" },
  drill: "d-rev",
  ...o,
});
const sources: Sources = {
  range: { label: "Last 30 days", days: [] },
  sources: [
    {
      id: SRC,
      name: "Spring fair",
      leads: 120,
      leadShare: 0.6,
      winRate: 0.1,
      tooFew: false,
      won: 12,
      revenue: 50000,
      revenueShare: 0.5,
      spend: 12000,
      costPerLead: 100,
      returnPerSpent: 4.17,
    },
    {
      id: null,
      name: "Added in LUME",
      leads: 8,
      leadShare: 0.04,
      winRate: null,
      tooFew: true,
      won: 0,
      revenue: 0,
      revenueShare: 0,
      spend: null,
      costPerLead: null,
      returnPerSpent: null,
    },
  ],
};
const base = {
  catalog: testCatalog(),
  compare: true,
  rangeWords: "in the last 30 days",
  canEditSpend: true,
  onDrill: vi.fn(),
};

describe("Revenue & sources (canvas Revenue)", () => {
  it("this month against the goal: won so far, where the pace ends, and how far in", () => {
    render(<RevenueBoard revenue={revenue()} sources={sources} {...base} />);
    const card = screen.getByRole("region", { name: "October, against the goal" });
    expect(card).toHaveTextContent("On pace for");
    expect(within(card).getByText(/On pace for/)).toHaveAttribute("data-tone", "bad");
    expect(card).toHaveTextContent("7 days in");
    // The days as a table, for a screen reader.
    expect(within(card).getAllByRole("row")).toHaveLength(7);
  });

  it("By month shows the last twelve months; clicking the line opens the month's revenue", async () => {
    const onDrill = vi.fn();
    render(<RevenueBoard revenue={revenue()} sources={sources} {...base} onDrill={onDrill} />);
    await userEvent.click(screen.getByRole("button", { name: /^Revenue won this month/ }));
    expect(onDrill).toHaveBeenCalledWith("d-rev", "Revenue won");
    await userEvent.click(screen.getByRole("radio", { name: "By month" }));
    expect(screen.getByRole("region", { name: "Revenue won, month by month" })).toHaveTextContent("+25%");
  });

  it("by package: each one's money and share, the fact beside it, and its won leads on a click", async () => {
    const onDrill = vi.fn();
    render(<RevenueBoard revenue={revenue()} sources={sources} {...base} onDrill={onDrill} />);
    const card = screen.getByRole("region", { name: "By package" });
    expect(card).toHaveTextContent("Signature is 30% of deals, and 60% of revenue");
    await userEvent.click(within(card).getByRole("button", { name: /Signature/ }));
    expect(onDrill).toHaveBeenCalledWith("d-p1", "Won: Signature");
  });

  it("sources: conversion, spend and its return; a source without spend offers to add it", () => {
    render(<RevenueBoard revenue={revenue()} sources={sources} {...base} />);
    const table = within(screen.getByRole("region", { name: "Sources" })).getByRole("table");
    const [, fair, mine] = within(table).getAllByRole("row");
    expect(fair).toHaveTextContent("4.2×");
    expect(fair).toHaveTextContent("File import");
    expect(mine).toHaveTextContent("Too few");
    expect(screen.getByRole("link", { name: "Set it in Settings → Sources & spend" })).toHaveAttribute(
      "href",
      "/settings/sources",
    );
  });

  it("without the money permission: no revenue cards and no money columns", () => {
    render(<RevenueBoard revenue={undefined} sources={sources} {...base} canEditSpend={false} />);
    expect(screen.queryByRole("region", { name: /against the goal/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Revenue won")).not.toBeInTheDocument();
    expect(screen.queryByText("Return on spend")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sources" })).toHaveTextContent("Spring fair");
  });
});
