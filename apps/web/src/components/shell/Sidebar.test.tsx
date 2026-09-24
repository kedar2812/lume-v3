import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PERMISSIONS, TOUR_STEPS } from "@lume/core/shared";
import { fakeSession } from "@/server/session";
import { AppShell } from "./AppShell";
import { Sidebar } from "./Sidebar";

const ALL_PERMISSIONS = PERMISSIONS.map((p) => ({ key: p.key, scope: p.scoped ? ("all" as const) : null }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/leads",
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

describe("Sidebar", () => {
  it("puts LUME on top and the client's name below", () => {
    render(
      <Sidebar businessName="Nupuur Coaching" user={{ name: "Tasneem", role: "Admin" }} can={() => true} />,
    );
    const lockup = screen.getByTestId("lockup");
    const [brand, client] = within(lockup).getAllByText(/LUME|Nupuur Coaching/);
    expect(brand).toHaveTextContent("LUME");
    expect(client).toHaveTextContent("Nupuur Coaching");
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
        businessName="Nupuur Coaching"
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
