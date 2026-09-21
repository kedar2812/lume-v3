import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  it("switches data-theme on <html> and remembers it in a cookie", async () => {
    document.documentElement.dataset.theme = "system";
    render(<ThemeToggle initial="system" />);
    await userEvent.click(screen.getByRole("radio", { name: "Obsidian" }));
    expect(document.documentElement.dataset.theme).toBe("obsidian");
    expect(document.cookie).toContain("lume_theme=obsidian");
    expect(screen.getByRole("radio", { name: "Obsidian" })).toHaveAttribute("aria-checked", "true");
  });
});
