import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MobileTabs } from "./MobileTabs";

vi.mock("next/navigation", () => ({ usePathname: () => "/templates" }));

describe("the phone's tab bar (canvas Phone)", () => {
  it("Today, Leads, Calendar and Settings at hand; the rest under More, which marks where you are", async () => {
    render(<MobileTabs can={() => true} />);
    const bar = screen.getByRole("navigation", { name: "Tabs" });
    expect(
      within(bar)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Today", "Leads", "Calendar", "Settings"]);
    const more = within(bar).getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("data-on");
    await userEvent.click(more);
    const menu = screen.getByRole("menu", { name: "More" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((l) => l.textContent),
    ).toEqual(["Pipeline", "Templates", "Analytics"]);
    expect(within(menu).getByRole("menuitem", { name: "Templates" })).toHaveAttribute("aria-current", "page");
  });

  it("only what the person may open", () => {
    render(<MobileTabs can={(p) => p === "leads.view"} />);
    const bar = screen.getByRole("navigation", { name: "Tabs" });
    expect(
      within(bar)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Today", "Leads", "Settings"]);
    expect(within(bar).getByRole("button", { name: "More" })).toBeInTheDocument();
  });
});
