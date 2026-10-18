import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PresetGlyph, WhereFromStep } from "./WhereFromStep";

/** Third-party apps show their own official, unmodified files from /brand (owner's ruling 2026-10-18). */
describe("where leads come from", () => {
  it("Zapier and Make show their official marks; the website form keeps LUME's neutral mark", () => {
    const { container } = render(<WhereFromStep manychat={false} busy={false} onCreate={vi.fn()} />);
    const zapier = screen.getByRole("radio", { name: /Zapier/ }).closest("label")!;
    const make = screen.getByRole("radio", { name: /Make/ }).closest("label")!;
    expect(zapier.querySelector("img")).toHaveAttribute("src", "/brand/zapier.ico");
    expect(make.querySelector("img")).toHaveAttribute("src", "/brand/make.png");
    // The name beside it says what it is: the mark itself is decoration.
    expect(zapier.querySelector("img")).toHaveAttribute("alt", "");
    const website = screen.getByRole("radio", { name: /Website form/ }).closest("label")!;
    expect(website.querySelector("img")).toBeNull();
    expect(website.querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(2);
  });

  it("a mark on its own, at the large size, for one webhook's page", () => {
    const { container } = render(<PresetGlyph preset="make" large />);
    expect(container.querySelector("img")).toHaveAttribute("width", "28");
  });
});
