import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationsClient } from "@/lib/notifications/client";
import { TopBar } from "./TopBar";

const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/leads", useRouter: () => ({ push }) }));
vi.mock("@/components/theme/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/lib/notifications/client", () => ({
  notificationsClient: { list: vi.fn() },
  READ_EVENT: "lume:notifications-read",
}));
let live: ((n: unknown) => void) | null = null;
vi.mock("@/lib/notifications/stream", () => ({ useStream: (on: (n: unknown) => void) => void (live = on) }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => vi.clearAllMocks());

describe("the bell", () => {
  it("shows a dot when something's unread, and opens Today", async () => {
    vi.mocked(notificationsClient.list).mockResolvedValue(ok({ items: [], unread: 2 }));
    render(<TopBar theme="system" onSearch={vi.fn()} />);
    expect(
      await screen.findByRole("button", { name: "Notifications, new ones waiting" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(push).toHaveBeenCalledWith("/today");
  });

  it("a live one lights it; reading them all lets it go", async () => {
    vi.mocked(notificationsClient.list).mockResolvedValue(ok({ items: [], unread: 0 }));
    render(<TopBar theme="system" onSearch={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeInTheDocument();
    await act(async () => live?.({ id: 1, title: "Follow up — Aisha" }));
    expect(screen.getByRole("button", { name: "Notifications, new ones waiting" })).toBeInTheDocument();
    await act(async () => void window.dispatchEvent(new Event("lume:notifications-read")));
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
  });
});
