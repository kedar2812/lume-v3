import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { trend } from "@lume/core/shared";
import { analyticsClient } from "@/lib/analytics/client";
import { testCatalog, testLead } from "@/lib/leads/test-catalog";
import { Analytics } from "./Analytics";

const replace = vi.fn();
let params = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/analytics",
  useSearchParams: () => params,
}));
vi.mock("@/lib/analytics/client", async (orig) => {
  const real = await orig<typeof import("@/lib/analytics/client")>();
  const fn = () => vi.fn();
  return {
    ...real,
    analyticsClient: {
      overview: fn(),
      funnel: fn(),
      team: fn(),
      sources: fn(),
      lost: fn(),
      timing: fn(),
      templates: fn(),
      quality: fn(),
      insights: fn(),
      goals: fn(),
      drill: fn(),
    },
  };
});
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const days = ["2026-09-04", "2026-09-05", "2026-09-06"];

beforeEach(() => {
  params = new URLSearchParams();
  replace.mockReset();
  const c = vi.mocked(analyticsClient);
  c.overview.mockResolvedValue(
    ok({
      range: { label: "September 4 – 6", days },
      tiles: [
        { id: "new_leads", value: 420, previous: 400, trend: trend(420, 400) },
        { id: "reply_rate", value: 0.41, previous: 0.33, trend: trend(0.41, 0.33, { kind: "pts" }), n: 300 },
        { id: "won", value: 25, previous: 26, trend: trend(25, 26) },
        { id: "overdue_now", value: 7, previous: null, trend: null },
      ],
      series: {
        days,
        newLeads: [100, 150, 170],
        won: [5, 9, 11],
        previous: { newLeads: [90, 120, 190], won: [6, 8, 12] },
        bySource: [{ id: "s1", name: "Spring fair", values: [100, 150, 170] }],
      },
      drill: { new_leads: "tok-new", won: "tok-won", overdue_now: "tok-over" },
    }),
  );
  c.funnel.mockResolvedValue(
    ok({
      range: { label: "September 4 – 6", days },
      arrived: 420,
      previousArrived: 400,
      stages: [
        {
          id: "a",
          name: "New",
          kind: "open",
          reached: 420,
          share: 1,
          stopped: 0.2,
          stoppedN: 84,
          tooFew: false,
          trend: null,
        },
        {
          id: "b",
          name: "Won",
          kind: "won",
          reached: 25,
          share: 25 / 420,
          stopped: null,
          stoppedN: 25,
          tooFew: false,
          trend: null,
        },
      ],
    }),
  );
  c.timing.mockResolvedValue(
    ok({ range: { label: "", days }, arrivals: [], replies: [], booking: [], stages: [] }),
  );
  c.quality.mockResolvedValue(
    ok({
      range: { label: "", days },
      phoneNeedsCountry: 3,
      phoneInvalid: 0,
      unowned: { under1h: 1, under1d: 0, over1d: 0 },
      importsRejected: [],
    }),
  );
  c.insights.mockResolvedValue(
    ok({
      ready: true as const,
      insights: [
        {
          id: "speed_pays",
          subject: "all",
          title: "Speed pays off",
          body: "Leads contacted within an hour were won 3.0 times as often.",
          magnitude: 3,
        },
      ],
    }),
  );
  c.goals.mockResolvedValue(
    ok({ period: "month" as const, periodStart: "2026-09-01", periodEnd: "2026-09-30", goals: [] }),
  );
  c.drill.mockResolvedValue(
    ok({
      kind: "won" as const,
      total: 1,
      capped: false,
      items: [testLead({ id: "l1", name: "Aisha Khan" })],
      nextCursor: null,
    }),
  );
});

describe("Analytics (8C)", () => {
  it("leads with a headline from the numbers, tiles with the owner's trend rule, and what LUME noticed", async () => {
    render(<Analytics catalog={testCatalog()} showTeam timezone="Asia/Kolkata" />);
    expect(await screen.findByRole("heading", { name: "A good month. Replies are up." })).toBeInTheDocument();
    const leads = screen.getByRole("button", { name: /^New leads: 420, \+5\.0%\. See the leads\./ });
    expect(leads).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Reply rate: 41%, \+8\.0 pts/ })).toBeInTheDocument();
    expect(await screen.findByText("Speed pays off")).toBeInTheDocument();
    expect(screen.getByText("Numbers need a country").closest("button")).toHaveTextContent("3");
    expect(screen.getByText("84 stopped here · −20%")).toBeInTheDocument();
  });

  it("a number opens the leads behind it on the full-window scrim, and closes with Escape", async () => {
    render(<Analytics catalog={testCatalog()} showTeam timezone="Asia/Kolkata" />);
    await userEvent.click(await screen.findByRole("button", { name: /^Won: 25/ }));
    const sheet = await screen.findByRole("dialog", { name: "The leads behind it: Won" });
    expect(analyticsClient.drill).toHaveBeenCalledWith("tok-won");
    expect(await within(sheet).findByText("Aisha Khan")).toBeInTheDocument();
    expect(sheet.closest("[data-scrim]")?.parentElement).toBe(document.body);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("the range and module live in the address; a rep's bar has no Team tab", async () => {
    const { unmount } = render(<Analytics catalog={testCatalog()} showTeam timezone="Asia/Kolkata" />);
    await userEvent.click(screen.getByRole("tab", { name: "Funnel" }));
    expect(replace).toHaveBeenCalledWith("/analytics?m=funnel", { scroll: false });
    await userEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
    await userEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(replace).toHaveBeenLastCalledWith("/analytics?range=7d", { scroll: false });
    unmount();
    render(<Analytics catalog={testCatalog()} showTeam={false} timezone="Asia/Kolkata" />);
    expect(screen.queryByRole("tab", { name: "Team" })).not.toBeInTheDocument();
  });
});
