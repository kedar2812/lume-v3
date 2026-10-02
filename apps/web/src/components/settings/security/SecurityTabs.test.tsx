import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecurityTabs } from "./SecurityTabs";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/security/rules" }));

describe("Security's tabs (6A Task 6)", () => {
  it("are links, the current one marked", () => {
    render(
      <SecurityTabs
        tabs={[
          { href: "/settings/security", label: "Overview" },
          { href: "/settings/security/rules", label: "Rules" },
        ]}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Security" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rules" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });
});
