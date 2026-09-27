import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sheetsClient } from "@/lib/sheets/client";
import type { SheetSourceView } from "@/lib/sheets/types";
import { Integrations } from "./Integrations";

vi.mock("@/lib/sheets/client", () => ({
  sheetsClient: { integrations: vi.fn(), setEnabled: vi.fn(), list: vi.fn() },
}));
vi.mock("@/components/sheets/AddSheetSheet", () => ({
  AddSheetSheet: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Add a sheet" /> : null,
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const on = { googleSheets: { enabled: true, available: true, email: "lume@p.iam.gserviceaccount.com" } };
const src = (over: Partial<SheetSourceView>): SheetSourceView => ({
  id: "s1",
  name: "Website enquiries",
  status: "active",
  attention: null,
  tabTitle: "Form responses",
  link: "https://docs.google.com/spreadsheets/d/x/edit#gid=0",
  pollSeconds: 120,
  lastSyncedAt: new Date(Date.now() - 120_000).toISOString(),
  nextSyncAt: null,
  syncing: false,
  failing: false,
  lastError: null,
  newColumns: [],
  newToday: 12,
  newAllTime: 340,
  problems: 0,
  runAs: { id: "u1", name: "Riya Sharma" },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("Settings → Integrations", () => {
  it("is off by default: one switch, and nothing else to do", async () => {
    vi.mocked(sheetsClient.integrations).mockResolvedValue(
      ok({ googleSheets: { ...on.googleSheets, enabled: false } }),
    );
    render(<Integrations />);
    const sw = await screen.findByRole("switch", { name: "Google Sheets" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Add a sheet" })).toBeNull();
    // The official mark, decorative (alt=""), so it's found by its file rather than a role.
    expect(document.querySelector('img[src="/brand/google-sheets.png"]')).not.toBeNull();
  });

  it("without a Google key on the server, says who can set it up instead of a switch", async () => {
    vi.mocked(sheetsClient.integrations).mockResolvedValue(
      ok({ googleSheets: { enabled: false, available: false, email: null } }),
    );
    render(<Integrations />);
    expect(await screen.findByText(/isn't set up on this server yet/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("switched on: the email to share with (copyable), every sheet's health, and Add a sheet", async () => {
    vi.mocked(sheetsClient.integrations).mockResolvedValue(ok(on));
    vi.mocked(sheetsClient.list).mockResolvedValue(
      ok({
        sources: [
          src({}),
          src({
            id: "s2",
            name: "Ads leads",
            status: "needs_attention",
            attention: { code: "ACCESS_LOST", message: "LUME can't open this sheet any more." },
            newToday: 0,
          }),
        ],
      }),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Integrations />);
    expect(await screen.findByText("lume@p.iam.gserviceaccount.com")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy email" }));
    expect(writeText).toHaveBeenCalledWith("lume@p.iam.gserviceaccount.com");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    const first = screen.getByRole("link", { name: /Website enquiries/ });
    expect(first).toHaveAttribute("href", "/settings/integrations/s1");
    expect(within(first).getByText(/Checked 2 min ago · 12 new today/)).toBeInTheDocument();
    expect(
      within(screen.getByRole("link", { name: /Ads leads/ })).getByText("Needs attention"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("“Ads leads” needs attention");
    await userEvent.click(screen.getByRole("button", { name: "Add a sheet" }));
    expect(screen.getByRole("dialog", { name: "Add a sheet" })).toBeInTheDocument();
  });

  it("switching on asks the server, then shows what's there", async () => {
    vi.mocked(sheetsClient.integrations).mockResolvedValue(
      ok({ googleSheets: { ...on.googleSheets, enabled: false } }),
    );
    vi.mocked(sheetsClient.setEnabled).mockResolvedValue(ok(on));
    vi.mocked(sheetsClient.list).mockResolvedValue(ok({ sources: [] }));
    render(<Integrations />);
    await userEvent.click(await screen.findByRole("switch", { name: "Google Sheets" }));
    expect(sheetsClient.setEnabled).toHaveBeenCalledWith(true);
    expect(await screen.findByText(/No sheets yet/)).toBeInTheDocument();
  });

  it("while a sheet is checking, the list looks again until it's done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(sheetsClient.integrations).mockResolvedValue(ok(on));
    vi.mocked(sheetsClient.list)
      .mockResolvedValueOnce(ok({ sources: [src({ syncing: true, newToday: 0 })] }))
      .mockResolvedValue(ok({ sources: [src({ syncing: false, newToday: 2 })] }));
    render(<Integrations />);
    expect(await screen.findByText(/Checking now · 0 new today/)).toBeInTheDocument();
    await act(async () => void (await vi.advanceTimersByTimeAsync(2100)));
    expect(await screen.findByText(/2 new today/)).toBeInTheDocument();
    vi.useRealTimers();
  });
});
