import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectCards } from "./ConnectCards";

describe("onboarding's Connect cards", () => {
  it("Google Calendar's Connect leads to the Calendar page, where connecting happens right there", () => {
    render(<ConnectCards calendar sheets={false} />);
    expect(screen.getByRole("link", { name: /connect/i })).toHaveAttribute("href", "/calendar");
  });

  it("shows no card for what this build doesn't have", () => {
    render(<ConnectCards calendar={false} sheets={false} />);
    expect(screen.queryByRole("link", { name: /connect/i })).not.toBeInTheDocument();
  });
});
