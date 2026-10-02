import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { Alert, AlertDetail } from "@/lib/settings/security";
import { BurstChart } from "./BurstChart";
import { OverviewTab } from "./OverviewTab";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const TZ = "Asia/Dubai";

// 9:41 am in Dubai is 05:41Z.
const open: Alert = {
  id: "a-1",
  user: { id: "u-rory", name: "Rory Reid", initials: "RR" },
  rule: "reveals",
  action: "suspended",
  observed: 34,
  threshold: 30,
  windowStart: "2026-10-01T04:49:00Z",
  windowEnd: "2026-10-01T05:41:00Z",
  status: "open",
  resolution: null,
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-10-01T05:41:00Z",
};
const earlier: Alert = {
  ...open,
  id: "a-0",
  user: { id: "u-sam", name: "Sam Okafor", initials: "SO" },
  action: "alerted",
  status: "resolved",
  resolution: "restored",
  resolvedBy: "Maya Kapoor",
  resolvedAt: "2026-09-29T08:00:00Z",
};
const burst = Array.from({ length: 12 }, (_, i) => ({
  at: new Date(Date.parse("2026-10-01T05:30:00Z") + i * 60_000).toISOString(),
  n: i < 10 ? 3 : 2,
}));
const detail = (a: Alert): AlertDetail => ({
  alert: a,
  burst,
  timeline: [
    { at: "2026-10-01T05:41:00Z", words: "The 31st contact in an hour: the limit" },
    { at: "2026-10-01T05:41:00Z", words: "Ended Rory’s 2 sessions (Chrome · Windows, Safari · iPhone)" },
    { at: "2026-10-01T05:41:00Z", words: "Paused sign-in. Rory sees “Your access is paused”" },
    { at: "2026-10-01T05:42:00Z", words: "Told Maya Kapoor and Hana Ito" },
  ],
  person: { roles: ["Sales"], joined: "2026-03-02T09:00:00Z", leadCount: 214, usualPerDay: 4 },
  last30: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async (url: string) =>
    url.startsWith("/api/v1/security/alerts/")
      ? ok(detail(open))
      : ok({
          alerts: [
            {
              ...open,
              status: "resolved",
              resolution: "restored",
              resolvedBy: "Maya Kapoor",
              resolvedAt: open.windowEnd,
            },
            earlier,
          ],
        }),
  );
});

describe("Security → Overview (6A Task 8)", () => {
  it("one open alert: amber, with what LUME did and when", () => {
    render(<OverviewTab initial={[open, earlier]} timezone={TZ} openId={null} />);
    const status = screen.getByRole("region", { name: "1 alert needs you" });
    expect(status).toHaveTextContent("LUME paused Rory Reid’s access at 9:41 am.");
    const row = screen.getByRole("button", { name: /Rory Reid opened 34 contacts in 52 minutes/ });
    expect(row).toHaveTextContent("Paused");
    expect(screen.getByText(/Restored by Maya Kapoor · Sep 29, Tue/)).toBeInTheDocument();
  });

  it("nothing open: green, and calm", () => {
    render(<OverviewTab initial={[earlier]} timezone={TZ} openId={null} />);
    expect(screen.getByRole("region", { name: "All quiet" })).toHaveTextContent(
      "LUME is watching. Nothing needs you right now.",
    );
  });

  it("Review opens the alert: the burst, what LUME did, and the choices", async () => {
    render(<OverviewTab initial={[open]} timezone={TZ} openId={null} />);
    await userEvent.click(screen.getByRole("button", { name: /Rory Reid opened 34 contacts/ }));
    const drawer = await screen.findByRole("dialog", { name: "Alert: Rory Reid" });
    expect(await within(drawer).findByText("Told Maya Kapoor and Hana Ito")).toBeInTheDocument();
    expect(within(drawer).getByText(/Sales · joined in March · 214 leads/)).toBeInTheDocument();
    expect(
      within(drawer).getByText(/Your limit is 30 an hour; Rory usually opens about 4 a day\./),
    ).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /Restore access/ })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /Keep Rory paused/ })).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: "Open Rory’s audit log" })).toHaveAttribute(
      "href",
      "/settings/audit?actor=u-rory",
    );
  });

  it("Restore: answered, folded into one line, and the status turns green", async () => {
    vi.mocked(api.post).mockResolvedValue(
      ok({ alert: { ...open, status: "resolved", resolution: "restored" } }),
    );
    render(<OverviewTab initial={[open]} timezone={TZ} openId="a-1" />);
    const drawer = await screen.findByRole("dialog", { name: "Alert: Rory Reid" });
    await userEvent.click(await within(drawer).findByRole("button", { name: /Restore access/ }));
    expect(api.post).toHaveBeenCalledWith("/api/v1/security/alerts/a-1/resolve", { resolution: "restored" });
    expect(await within(drawer).findByText("Rory has access again")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("region", { name: "All quiet" })).toBeInTheDocument());
  });

  it("Keep paused answers kept_suspended", async () => {
    vi.mocked(api.post).mockResolvedValue(
      ok({ alert: { ...open, status: "resolved", resolution: "kept_suspended" } }),
    );
    render(<OverviewTab initial={[open]} timezone={TZ} openId="a-1" />);
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(await within(drawer).findByRole("button", { name: /Keep Rory paused/ }));
    expect(api.post).toHaveBeenCalledWith("/api/v1/security/alerts/a-1/resolve", {
      resolution: "kept_suspended",
    });
    expect(await within(drawer).findByText("Rory stays paused")).toBeInTheDocument();
  });

  it("an alert that paused nobody offers Dismiss", async () => {
    const told = { ...open, action: "alerted" as const };
    vi.mocked(api.get).mockResolvedValue(ok(detail(told)));
    render(<OverviewTab initial={[told]} timezone={TZ} openId="a-1" />);
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByRole("button", { name: /^Dismiss/ })).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /Restore access/ })).not.toBeInTheDocument();
  });

  it("Escape closes it and focus goes back to the row", async () => {
    render(<OverviewTab initial={[open]} timezone={TZ} openId={null} />);
    const row = screen.getByRole("button", { name: /Rory Reid opened 34 contacts/ });
    await userEvent.click(row);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(row).toHaveFocus();
  });
});

describe("the burst chart", () => {
  it("marks the minute the limit was crossed, and the minutes past it", () => {
    render(<BurstChart burst={burst} threshold={30} timezone={TZ} label="Contacts opened, each minute" />);
    const bars = screen.getAllByTestId("burst-bar");
    // 3 a minute: 30 after ten minutes; the 11th minute takes it past 30.
    expect(bars[10]).toHaveAttribute("data-crossing", "true");
    expect(bars.filter((b) => b.dataset.over === "true")).toHaveLength(2);
    expect(screen.getByText("Limit reached")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: /Contacts opened, each minute: 34 in 12 minutes, past the limit at 9:40 am/,
      }),
    ).toBeInTheDocument();
  });
});
