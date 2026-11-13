import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PageError from "./error";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("a page that couldn't open (night QA 2026-11-13)", () => {
  it("says so in words, and Try again asks the server again", async () => {
    const reset = vi.fn();
    render(<PageError error={new Error("LUME's server didn't answer (0)")} reset={reset} />);
    expect(screen.getByRole("alert")).toHaveTextContent("LUME couldn’t open this page");
    expect(screen.getByRole("alert")).not.toHaveTextContent("didn't answer (0)");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalled();
    expect(reset).toHaveBeenCalled();
  });
});
