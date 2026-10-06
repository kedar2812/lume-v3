import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsPage } from "./SettingsPage";

describe("every Settings page has a way back (owner's polish list)", () => {
  it("a section goes back to All settings, above its title", () => {
    render(
      <SettingsPage title="Pipeline" description="The stages a lead moves through.">
        <p>body</p>
      </SettingsPage>,
    );
    const back = screen.getByRole("link", { name: "Back to All settings" });
    expect(back).toHaveAttribute("href", "/settings");
    expect(back).toHaveTextContent("All settings");
    // Before the heading in reading order, as a back arrow is.
    expect(back.compareDocumentPosition(screen.getByRole("heading", { level: 1 }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("a page inside a section goes back to that section", () => {
    render(
      <SettingsPage
        title="Calendly"
        description="…"
        up={{ href: "/settings/integrations", label: "Integrations" }}
      >
        <p>body</p>
      </SettingsPage>,
    );
    expect(screen.getByRole("link", { name: "Back to Integrations" })).toHaveAttribute(
      "href",
      "/settings/integrations",
    );
  });

  it("the Settings home, or a page with its own way back, has none", () => {
    render(
      <SettingsPage title="Settings" description="…" up={null}>
        <p>body</p>
      </SettingsPage>,
    );
    expect(screen.queryByRole("link", { name: /^Back to/ })).not.toBeInTheDocument();
  });
});
