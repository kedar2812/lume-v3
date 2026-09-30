import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationsClient } from "@/lib/notifications/client";
import { TopBar } from "./TopBar";

let path = "/leads";
vi.mock("next/navigation", () => ({ usePathname: () => path }));
vi.mock("@/components/theme/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/notifications/NotificationCentre", () => ({
  NotificationCentre: ({ open, onClose }: { open: boolean; onClose(): void }) =>
    open ? (
      <div role="dialog" aria-label="Notifications">
        <button onClick={onClose}>close</button>
      </div>
    ) : null,
}));
vi.mock("@/lib/notifications/client", () => ({
  notificationsClient: { list: vi.fn() },
  READ_EVENT: "lume:notifications-read",
}));
let live: ((n: unknown) => void) | null = null;
vi.mock("@/lib/notifications/stream", () => ({ useStream: (on: (n: unknown) => void) => void (live = on) }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.clearAllMocks();
  path = "/leads";
  document.title = "Leads · LUME";
});

describe("the bell", () => {
  it("says how many are unread, in its name and the window title, and opens the centre", async () => {
    vi.mocked(notificationsClient.list).mockResolvedValue(ok({ items: [], unread: 2 }));
    render(<TopBar theme="system" onSearch={vi.fn()} />);
    const bell = await screen.findByRole("button", { name: "Notifications, 2 unread" });
    // The title follows in an effect, after the render that named the bell.
    await vi.waitFor(() => expect(document.title).toBe("(2) Leads · LUME"));
    await userEvent.click(bell);
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
  });

  it("a live one adds to the count; reading them all lets it go", async () => {
    vi.mocked(notificationsClient.list).mockResolvedValue(ok({ items: [], unread: 0 }));
    render(<TopBar theme="system" onSearch={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeInTheDocument();
    await act(async () => live?.({ id: 1, title: "Follow up — Aisha" }));
    expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeInTheDocument();
    await act(async () => void window.dispatchEvent(new Event("lume:notifications-read")));
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(document.title).toBe("Leads · LUME");
  });

  it("'.' opens and closes the centre, but not while typing", async () => {
    vi.mocked(notificationsClient.list).mockResolvedValue(ok({ items: [], unread: 0 }));
    render(
      <>
        <TopBar theme="system" onSearch={vi.fn()} />
        <input aria-label="Somewhere to type" />
      </>,
    );
    await userEvent.keyboard(".");
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    await userEvent.keyboard(".");
    expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Somewhere to type"), ".");
    expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument();
  });
});

describe("the bell: 3B final review", () => {
  it("Important 5: the window title keeps its count on the next page", async () => {
    vi.mocked(notificationsClient.list).mockResolvedValue(ok({ items: [], unread: 2 }));
    const { rerender } = render(<TopBar theme="system" onSearch={vi.fn()} />);
    await screen.findByRole("button", { name: "Notifications, 2 unread" });
    document.title = "Today · LUME"; // what Next sets on a client-side move
    path = "/today";
    rerender(<TopBar theme="system" onSearch={vi.fn()} />);
    expect(document.title).toBe("(2) Today · LUME");
  });

  it("Important 5: a read says how many are left, and the bell follows", async () => {
    vi.mocked(notificationsClient.list).mockResolvedValue(ok({ items: [], unread: 4 }));
    render(<TopBar theme="system" onSearch={vi.fn()} />);
    await screen.findByRole("button", { name: "Notifications, 4 unread" });
    await act(
      async () =>
        void window.dispatchEvent(new CustomEvent("lume:notifications-read", { detail: { unread: 3 } })),
    );
    expect(screen.getByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
  });

  it("Important 5: '.' closes the way the bell does: the count is fetched again and focus comes back", async () => {
    vi.mocked(notificationsClient.list).mockResolvedValue(ok({ items: [], unread: 0 }));
    render(<TopBar theme="system" onSearch={vi.fn()} />);
    await userEvent.keyboard(".");
    await userEvent.keyboard(".");
    expect(notificationsClient.list).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Notifications" })).toHaveFocus();
  });

  it("an arrival is said to screen readers too, politely", async () => {
    vi.mocked(notificationsClient.list).mockResolvedValue(ok({ items: [], unread: 0 }));
    render(<TopBar theme="system" onSearch={vi.fn()} />);
    await screen.findByRole("button", { name: "Notifications" });
    await act(async () => live?.({ id: 7, title: "Follow up — Aisha" }));
    const said = screen.getByRole("status");
    expect(said).toHaveAttribute("aria-live", "polite");
    expect(said).toHaveTextContent("New notification: Follow up — Aisha");
  });
});
