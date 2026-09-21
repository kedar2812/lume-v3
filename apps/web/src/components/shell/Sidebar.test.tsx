import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

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
});
