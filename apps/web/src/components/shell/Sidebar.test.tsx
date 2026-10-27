import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PERMISSIONS, TOUR_STEPS } from "@lume/core/shared";
import { fakeSession } from "@/server/session";
import { AppShell } from "./AppShell";
import { Sidebar } from "./Sidebar";

const ALL_PERMISSIONS = PERMISSIONS.map((p) => ({ key: p.key, scope: p.scoped ? ("all" as const) : null }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/leads",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));
// Saved views (4B) have their own tests; here the sidebar has none.
vi.mock("@/lib/views/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/views/client")>()),
  viewsClient: {
    list: vi.fn(async () => ({ ok: true, status: 200, data: { views: [] } })),
    counts: vi.fn(async () => ({ ok: true, status: 200, data: { counts: {} } })),
  },
}));

let aiOn = false;
let running = 0;
vi.mock("@/lib/ai/use-ai-on", () => ({ useAiOn: () => aiOn }));
vi.mock("@/lib/autopilot/use-run", () => ({ useLiveRuns: (on: boolean) => (on ? running : 0) }));
let batch: { total: number; added: number; share: number; done: boolean } | null = null;
vi.mock("@/lib/media/uploads", async (orig) => ({
  ...(await orig<typeof import("@/lib/media/uploads")>()),
  useUploadBatch: () => batch,
}));

describe("Sidebar", () => {
  it("LUME AI is always there, with its own mark drawing itself; Live while a run is going (owner, 2026-10-27)", () => {
    // Named LUME AI, not Autopilot: one name for the assistant everywhere. Off, it's still there: its page says how
    // to switch it on, rather than the item vanishing.
    aiOn = false;
    const { unmount } = render(
      <Sidebar businessName="X" user={{ name: "Riya", role: "Sales" }} can={() => true} />,
    );
    const item = screen.getByRole("link", { name: "LUME AI" });
    expect(item).toHaveAttribute("href", "/autopilot");
    expect(item.querySelector("[data-draw='loop']")).not.toBeNull();
    expect(screen.queryByRole("link", { name: /Autopilot/ })).toBeNull();
    unmount();
    aiOn = true;
    running = 2;
    render(<Sidebar businessName="X" user={{ name: "Riya", role: "Sales" }} can={() => true} />);
    expect(screen.getByRole("link", { name: "LUME AI, live" })).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    aiOn = false;
    running = 0;
  });

  it("Media carries a ring while files go up, said with how far; a tick and three blinks once they're in", () => {
    batch = { total: 40, added: 12, share: 0.344, done: false };
    const going = render(
      <Sidebar businessName="X" user={{ name: "Riya", role: "Sales" }} can={() => true} />,
    );
    const link = screen.getByRole("link", { name: "Media, uploading 34%" });
    expect(link).toHaveAttribute("href", "/media");
    // Hovered, it says the whole batch's progress.
    expect(within(link).getByText("Uploading 12 of 40 · 34%")).toBeInTheDocument();
    // Only Media carries it.
    expect(screen.getAllByText("Uploading 12 of 40 · 34%")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Leads" })).toBeInTheDocument();
    expect(link).not.toHaveAttribute("data-blink");
    going.unmount();
    batch = { total: 40, added: 40, share: 1, done: true };
    const done = render(<Sidebar businessName="X" user={{ name: "Riya", role: "Sales" }} can={() => true} />);
    const added = screen.getByRole("link", { name: "Media, 40 files added" });
    expect(added).toHaveAttribute("data-blink");
    done.unmount();
    batch = null;
    render(<Sidebar businessName="X" user={{ name: "Riya", role: "Sales" }} can={() => true} />);
    expect(screen.getByRole("link", { name: "Media" })).not.toHaveAttribute("data-blink");
  });

  it("puts LUME on top and the client's name below", () => {
    render(
      <Sidebar businessName="Brightpath Studio" user={{ name: "Leila", role: "Admin" }} can={() => true} />,
    );
    const lockup = screen.getByTestId("lockup");
    const [brand, client] = within(lockup).getAllByText(/LUME|Brightpath Studio/);
    expect(brand).toHaveTextContent("LUME");
    expect(client).toHaveTextContent("Brightpath Studio");
  });

  it("marks the current section and omits sections the role can't use", () => {
    render(
      <Sidebar businessName="X" user={{ name: "Riya", role: "Sales" }} can={(p) => p === "leads.view"} />,
    );
    expect(screen.getByRole("link", { name: /Leads/ })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: /Analytics/ })).not.toBeInTheDocument();
  });

  it("renders a target for every tour step, so a refactor can't silently break the tour (spec §5)", () => {
    render(
      <AppShell
        session={fakeSession({
          permissions: ALL_PERMISSIONS,
          tour: { version: 1, step: 0, completedAt: "2026-09-20T10:00:00Z", skippedAt: null },
        })}
        businessName="Brightpath Studio"
        theme="porcelain"
      >
        <div />
      </AppShell>,
    );
    for (const target of new Set(TOUR_STEPS.map((s) => s.target))) {
      expect(
        document.querySelector(`[data-tour="${target}"]`),
        `missing data-tour="${target}"`,
      ).not.toBeNull();
    }
  });
});

describe("Send feedback in the profile menu (spec 2026-10-16 §1.1)", () => {
  it("sits between Replay the tour and Sign out, and opens the sheet", async () => {
    const onFeedback = vi.fn();
    render(
      <Sidebar
        businessName="X"
        user={{ name: "Priya Shah", role: "Sales" }}
        can={() => true}
        onFeedback={onFeedback}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Priya Shah/ }));
    const menu = screen.getByRole("menu", { name: "Your account" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Replay the tour", "Send feedback", "Sign out"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Send feedback" }));
    expect(onFeedback).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("isn't there when there's nowhere to send it", async () => {
    render(<Sidebar businessName="X" user={{ name: "Priya Shah", role: "Sales" }} can={() => true} />);
    await userEvent.click(screen.getByRole("button", { name: /Priya Shah/ }));
    expect(screen.queryByRole("menuitem", { name: "Send feedback" })).toBeNull();
  });
});
