import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sheetsClient } from "@/lib/sheets/client";
import type { RefreshProgress } from "@/lib/sheets/types";
import { RefreshButton } from "./RefreshButton";

vi.mock("@/lib/sheets/client", () => ({ sheetsClient: { refresh: vi.fn(), progress: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const progress = (over: Partial<RefreshProgress>): RefreshProgress => ({
  status: "done",
  rowsRead: 3,
  rowsTotal: 3,
  created: 3,
  merged: 0,
  leadIds: ["a", "b", "c"],
  unreachable: false,
  retryInS: null,
  attention: [],
  ...over,
});
const run = async (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(sheetsClient.refresh).mockResolvedValue(ok({ id: "r1" }));
});
afterEach(() => vi.useRealTimers());

describe("Refresh", () => {
  it("syncs, shows real progress, says the real count once, then settles back into the button", async () => {
    vi.mocked(sheetsClient.progress)
      .mockResolvedValueOnce(ok(progress({ status: "running", rowsRead: 1, rowsTotal: 3, created: 1 })))
      .mockResolvedValue(ok(progress({ merged: 2 })));
    const onArrived = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RefreshButton personal={false} onArrived={onArrived} />);
    const btn = screen.getByRole("button", { name: /Refresh/ });
    await user.click(btn);
    expect(screen.getByRole("status")).toHaveTextContent("Syncing new enquiries");
    expect(btn).toHaveAttribute("aria-disabled", "true");
    await run(900);
    expect(screen.getByText("Reading rows… 1 of 3")).toBeInTheDocument();
    await run(1500);
    expect(screen.getByRole("status")).toHaveTextContent("3 new leads · 2 merged into existing ones");
    // On the card too, not only in the announcement.
    expect(
      screen.getByText(/merged into existing ones/, { selector: "p:not([role=status])" }),
    ).toBeInTheDocument();
    await run(1400); // result (1.3 s) → back into the button (0.62 s) → "✓ 3 new" for 1.6 s
    expect(onArrived).toHaveBeenCalledWith(expect.objectContaining({ created: 3, leadIds: ["a", "b", "c"] }));
    expect(screen.getByRole("button", { name: /3 new/ })).toBe(btn);
    expect(document.activeElement).toBe(btn); // focus never left it
    await run(2500);
    expect(screen.getByRole("button", { name: /^Refresh/ })).not.toHaveAttribute("aria-disabled");
  });

  it("a rep hears what's theirs: “1 new lead for you”", async () => {
    vi.mocked(sheetsClient.progress).mockResolvedValue(ok(progress({ created: 1, leadIds: ["a"] })));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RefreshButton personal onArrived={() => undefined} />);
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await run(2500);
    expect(screen.getByRole("status")).toHaveTextContent("1 new lead for you");
  });

  it("nothing new is “Up to date”; Google unreachable is said calmly", async () => {
    vi.mocked(sheetsClient.progress).mockResolvedValue(
      ok(progress({ created: 0, leadIds: [], rowsTotal: 0, rowsRead: 0 })),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = render(<RefreshButton personal={false} onArrived={() => undefined} />);
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await run(2500);
    expect(screen.getByRole("status")).toHaveTextContent("Up to date");
    unmount();
    vi.mocked(sheetsClient.progress).mockResolvedValue(
      ok(progress({ created: 0, leadIds: [], unreachable: true, retryInS: 290 })),
    );
    render(<RefreshButton personal={false} onArrived={() => undefined} />);
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await run(2500);
    // When it really tries again (the API's own next try), not a fixed wait.
    expect(screen.getByRole("status")).toHaveTextContent(
      "Couldn't reach Google. LUME will try again in 5 minutes.",
    );
  });

  it("R refreshes from anywhere on the page — but not while typing — and a press while busy is ignored", async () => {
    vi.mocked(sheetsClient.progress).mockResolvedValue(ok(progress({})));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <>
        <input aria-label="Search" />
        <RefreshButton personal={false} onArrived={() => undefined} />
      </>,
    );
    await user.type(screen.getByLabelText("Search"), "r");
    expect(sheetsClient.refresh).not.toHaveBeenCalled();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard("r");
    expect(sheetsClient.refresh).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /Refresh|Syncing/ }));
    expect(sheetsClient.refresh).toHaveBeenCalledTimes(1);
  });

  it("each refusal has its own title, not “Couldn't reach Google”", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    for (const [code, message, title] of [
      ["SHEETS_OFF", "Google Sheets is switched off.", "Google Sheets is off"],
      ["NO_SHEETS", "No Google Sheet is connected.", "No sheet to refresh"],
      ["OFFLINE", "LUME can’t reach the server right now.", "You're offline"],
    ] as const) {
      vi.mocked(sheetsClient.refresh).mockResolvedValue({ ok: false, status: 409, code, message } as never);
      const { unmount } = render(<RefreshButton personal={false} onArrived={() => undefined} />);
      await user.click(screen.getByRole("button", { name: /Refresh/ }));
      await run(1600);
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.queryByText("Couldn't reach Google")).not.toBeInTheDocument();
      await run(5000);
      unmount();
    }
  });

  it("a sheet that needs attention stays one tab away after the card has gone", async () => {
    vi.mocked(sheetsClient.progress).mockResolvedValue(
      ok(progress({ attention: [{ id: "s9", name: "Website enquiries" }] })),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RefreshButton personal={false} onArrived={() => undefined} />);
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await run(8000);
    const link = screen.getByRole("link", { name: "“Website enquiries” needs attention" });
    expect(link).toHaveAttribute("href", "/settings/integrations/s9");
    expect(link.closest("[aria-hidden]")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("“Website enquiries” needs attention");
  });
});
