import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationView } from "@/lib/notifications/client";
import { AlertHud } from "./AlertHud";

let live: ((n: NotificationView) => void) | null = null;
vi.mock("@/lib/notifications/stream", () => ({
  useStream: (on: (n: NotificationView) => void) => {
    live = on;
  },
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const alert = (id: number, alertId = "a-1"): NotificationView => ({
  id,
  kind: "security_alert",
  title: "LUME paused Rory Reid’s access",
  body: "34 contacts opened in 52 minutes",
  leadId: null,
  taskId: null,
  createdAt: new Date().toISOString(),
  read: false,
  alertId,
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe("the alert HUD (6A Task 8)", () => {
  it("rises once for a security alert, says it politely, and Review opens it", async () => {
    render(<AlertHud />);
    await act(async () => live?.(alert(1)));
    const hud = screen.getByRole("status");
    expect(hud).toHaveTextContent("LUME paused Rory Reid’s access");
    expect(hud).toHaveTextContent("34 contacts opened in 52 minutes");
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(push).toHaveBeenCalledWith("/settings/security?alert=a-1");
  });

  it("never shows the same alert twice, even after a reload", async () => {
    const { unmount } = render(<AlertHud />);
    await act(async () => live?.(alert(1)));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    unmount();
    render(<AlertHud />);
    await act(async () => live?.(alert(2, "a-1")));
    expect(screen.queryByText("LUME paused Rory Reid’s access")).not.toBeInTheDocument();
  });

  it("ignores every other kind of notification", async () => {
    render(<AlertHud />);
    await act(async () => live?.({ ...alert(3), kind: "lead_assigned", alertId: null }));
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
  });
});
