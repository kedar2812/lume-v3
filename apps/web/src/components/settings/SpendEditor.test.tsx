import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { analyticsClient } from "@/lib/analytics/client";
import { SpendEditor } from "./SpendEditor";

vi.mock("@/lib/api", () => ({ api: { put: vi.fn() } }));
vi.mock("@/lib/analytics/client", async (orig) => {
  const real = await orig<typeof import("@/lib/analytics/client")>();
  return { ...real, analyticsClient: { sources: vi.fn() } };
});
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const row = (id: string, name: string, leads: number, revenue: number) => ({
  id,
  name,
  leads,
  leadShare: null,
  winRate: null,
  tooFew: false,
  won: 3,
  revenue,
  revenueShare: null,
  spend: null,
  costPerLead: null,
  returnPerSpent: null,
});

beforeEach(() => {
  vi.mocked(api.put)
    .mockReset()
    .mockResolvedValue(ok({ id: "s1", monthlySpend: 0 }) as never);
  vi.mocked(analyticsClient.sources).mockResolvedValue(
    ok({
      range: { label: "", days: [] },
      sources: [row("s1", "Instagram ads", 100, 60_000), row("s2", "Referrals", 40, 90_000)],
    }),
  );
});
const initial = [
  { id: "s1", name: "Instagram ads", type: "webhook", status: "active", monthlySpend: 12_000 },
  { id: "s2", name: "Referrals", type: "manual", status: "active", monthlySpend: null },
];

describe("Settings → Sources & spend (8D-3)", () => {
  it("each source's spend, what a lead costs and what it brings back, from the last 30 days", async () => {
    render(<SpendEditor initial={initial} currency="AED" seesMoney />);
    const table = screen.getByRole("table");
    const ig = (await within(table).findByText("Instagram ads")).closest("tr")!;
    await within(ig).findByText("100");
    // 12,000 a month is about 11,828 for 30 days: 118 a lead, and 60,000 back is 5.1×.
    expect(ig).toHaveTextContent("AED 118");
    expect(ig).toHaveTextContent("5.1×");
    expect(within(table).getByText("Referrals").closest("tr")).toHaveTextContent("Free");
    expect(screen.getByText("1 paid source")).toBeInTheDocument();
  });

  it("saves a spend when you leave the box; empty means free; nonsense isn't saved", async () => {
    render(<SpendEditor initial={initial} currency="AED" seesMoney />);
    const box = screen.getByRole("textbox", { name: "Referrals: spend a month" });
    await userEvent.type(box, "4,500");
    await userEvent.tab();
    expect(api.put).toHaveBeenCalledWith("/api/v1/settings/sources/s2/spend", { monthlySpend: 4500 });
    const ig = screen.getByRole("textbox", { name: "Instagram ads: spend a month" });
    await userEvent.clear(ig);
    await userEvent.tab();
    expect(api.put).toHaveBeenLastCalledWith("/api/v1/settings/sources/s1/spend", { monthlySpend: null });
    await userEvent.type(ig, "lots");
    await userEvent.tab();
    expect(ig).toHaveAttribute("aria-invalid", "true");
    expect(api.put).toHaveBeenCalledTimes(2);
  });

  it("without the money permission: spend and cost per lead only", async () => {
    render(<SpendEditor initial={initial} currency="AED" seesMoney={false} />);
    expect(screen.queryByText("Revenue won")).not.toBeInTheDocument();
    expect(screen.queryByText(/spent$/)).not.toBeInTheDocument();
  });
});
