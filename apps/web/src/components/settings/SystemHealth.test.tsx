import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healthClient, type Health } from "@/lib/settings/health";
import { SystemHealth } from "./SystemHealth";

vi.mock("@/lib/settings/health", () => ({ healthClient: { get: vi.fn() } }));
// Send feedback, as the sheet the page opens: only what it was opened with matters here.
vi.mock("@/components/send-feedback/FeedbackSheet", () => ({
  FeedbackSheet: ({ open, initialText }: { open: boolean; initialText?: string }) =>
    open ? (
      <div role="dialog" aria-label="Send feedback">
        {initialText}
      </div>
    ) : null,
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const at = "2026-09-28T10:00:00.000Z";
const healthy: Health = {
  checkedAt: at,
  followUps: { lastSweepAt: "2026-09-28T09:59:28.000Z", pending: 12, late: 0, firedToday: 40 },
  queue: { waiting: 3, active: 0, retrying: 0, failed24h: 0 },
  digest: { lastSentAt: "2026-09-28T04:00:00.000Z", sentToday: 6, failures24h: 0 },
  noTouch: { enabled: true, lastRunAt: null, createdToday: 0 },
  sources: [{ id: "s1", name: "Site form", type: "webhook", status: "active", lastSyncAt: null }],
  restoreTest: { at: "2026-09-27T03:00:00.000Z", ok: true },
  storage: {
    diskTotal: 96 * 1024 ** 3,
    diskFree: 61 * 1024 ** 3,
    database: 1.2 * 1024 ** 3,
    whatsappFiles: 640 * 1024 ** 2,
  },
  problems: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(healthClient.get).mockResolvedValue(ok(healthy));
});
afterEach(() => vi.useRealTimers());

describe("System health (3C Task 7)", () => {
  it("one look: everything is running, and each promise with its numbers", () => {
    render(<SystemHealth initial={healthy} />);
    expect(screen.getByRole("heading", { name: "Everything is running" })).toBeInTheDocument();
    const reminders = screen.getByRole("region", { name: "Follow-up reminders" });
    expect(within(reminders).getByText("32 s ago")).toBeInTheDocument();
    expect(within(reminders).getByText("12")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Morning emails" })).toHaveTextContent("6");
    expect(screen.getByRole("region", { name: "Sources" })).toHaveTextContent("Site form");
    expect(screen.getByRole("region", { name: "Backups" })).toHaveTextContent(/passed/);
  });

  it("storage: how full the disk is as a bar, and what LUME keeps, in words people read", () => {
    render(<SystemHealth initial={healthy} />);
    const card = screen.getByRole("region", { name: "Storage" });
    const bar = within(card).getByRole("meter", { name: "Server disk in use" });
    expect(bar).toHaveAttribute("aria-valuenow", "36");
    expect(bar).not.toHaveAttribute("data-warn");
    expect(card).toHaveTextContent("36% in use");
    expect(card).toHaveTextContent("Free 61 GB of 96 GB");
    expect(card).toHaveTextContent("Database 1.2 GB");
    expect(card).toHaveTextContent("WhatsApp files 640 MB");
    expect(card).not.toHaveAttribute("data-warn");
  });

  it("storage: 85% or more warns; a disk LUME can't read is 'not known', with no bar", () => {
    const { unmount } = render(
      <SystemHealth initial={{ ...healthy, storage: { ...healthy.storage, diskFree: 9 * 1024 ** 3 } }} />,
    );
    expect(screen.getByRole("region", { name: "Storage" })).toHaveAttribute("data-warn");
    expect(screen.getByRole("meter")).toHaveAttribute("data-warn");
    unmount();
    render(
      <SystemHealth
        initial={{
          ...healthy,
          storage: { diskTotal: null, diskFree: null, database: null, whatsappFiles: 0 },
        }}
      />,
    );
    const card = screen.getByRole("region", { name: "Storage" });
    expect(within(card).queryByRole("meter")).toBeNull();
    expect(card).toHaveTextContent("Free not known");
    expect(card).toHaveTextContent("Database not known");
    // No WhatsApp files on this server (WhatsApp not used here): no line for them (owner, 2026-10-20).
    expect(card).not.toHaveTextContent("WhatsApp");
  });

  it("what needs a look, in words", () => {
    render(
      <SystemHealth
        initial={{
          ...healthy,
          followUps: { ...healthy.followUps, late: 2 },
          problems: [
            { key: "reminders_late", words: "2 reminders are late.", actions: ["tell"] },
            { key: "digest_failing", words: "Morning emails aren't going out.", actions: ["tell"] },
          ],
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "2 things need a look" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "What needs a look" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("Morning emails aren't going out.");
  });

  it("each problem says what to do: a place in LUME to fix it, or Tell LUME with the problem written in (owner, 2026-10-27)", async () => {
    render(
      <SystemHealth
        initial={{
          ...healthy,
          problems: [
            {
              key: "source:s1",
              words: "Site form needs attention: new leads from it may not be arriving.",
              actions: [{ label: "Open Site form", href: "/settings/integrations/s1" }],
            },
            {
              key: "files_backup",
              words: "Photos from WhatsApp haven't reached the off-site backup for over a day.",
              actions: ["tell"],
            },
          ],
        }}
      />,
    );
    const [source, backup] = within(screen.getByRole("list", { name: "What needs a look" })).getAllByRole(
      "listitem",
    );
    expect(within(source!).getByRole("link", { name: "Open Site form" })).toHaveAttribute(
      "href",
      "/settings/integrations/s1",
    );
    expect(within(source!).queryByRole("button", { name: "Tell LUME" })).toBeNull();
    await userEvent.click(within(backup!).getByRole("button", { name: "Tell LUME" }));
    expect(screen.getByRole("dialog", { name: "Send feedback" })).toHaveTextContent(
      "System health: Photos from WhatsApp haven't reached the off-site backup for over a day.",
    );
  });

  it("checks again every 30 s while it's on screen, and not while the tab is hidden", async () => {
    vi.useFakeTimers();
    render(<SystemHealth initial={healthy} />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(healthClient.get).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(90_000)));
    expect(healthClient.get).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(healthClient.get).toHaveBeenCalledTimes(2); // back on screen: at once
  });
});
