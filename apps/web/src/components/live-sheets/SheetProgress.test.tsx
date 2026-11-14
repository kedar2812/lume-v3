import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyLink } from "./CopyLink";
import { SheetProgress } from "./SheetProgress";

describe("SheetProgress", () => {
  it("says each step in words, under a bar that reads as a progress bar", () => {
    const { rerender } = render(<SheetProgress phase="making" total={0} written={0} />);
    expect(screen.getByText("Making your sheet in Google")).toBeInTheDocument();
    rerender(<SheetProgress phase="writing" total={3000} written={1200} />);
    expect(screen.getByText("Writing leads: 1,200 of 3,000")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Writing leads" });
    expect(bar).toHaveAttribute("aria-valuenow", "1200");
    expect(bar).toHaveAttribute("aria-valuemax", "3000");
    rerender(<SheetProgress phase="slow" total={3000} written={1200} />);
    expect(screen.getByText("Google is slow right now; LUME will keep going.")).toBeInTheDocument();
    rerender(<SheetProgress phase="live" total={3000} written={3000} count={3000} />);
    expect(screen.getByText("Live · 3,000 leads")).toBeInTheDocument();
  });

  it("never goes backwards: a lower count after a higher one keeps the higher", () => {
    const { rerender } = render(<SheetProgress phase="writing" total={1300} written={1000} />);
    rerender(<SheetProgress phase="writing" total={1300} written={500} />);
    expect(screen.getByText("Writing leads: 1,000 of 1,300")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1000");
  });

  it("one lead is one lead", () => {
    render(<SheetProgress phase="live" total={1} written={1} count={1} />);
    expect(screen.getByText("Live · 1 lead")).toBeInTheDocument();
  });
});

describe("CopyLink", () => {
  afterEach(() => vi.useRealTimers());

  it("copies the link, says Copied where screen readers hear it, then goes back", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyLink url="https://docs.google.com/spreadsheets/d/abc/edit" />);
    expect(screen.getByText("https://docs.google.com/spreadsheets/d/abc/edit")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("https://docs.google.com/spreadsheets/d/abc/edit");
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    expect(screen.getByRole("link", { name: "Open in Google Sheets" })).toHaveAttribute(
      "href",
      "https://docs.google.com/spreadsheets/d/abc/edit",
    );
  });

  it("when the browser won't copy, the link is selected for the person to copy themselves", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    render(<CopyLink url="https://docs.google.com/spreadsheets/d/abc/edit" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await act(async () => undefined);
    expect(screen.getByRole("status")).toHaveTextContent("Press Ctrl+C or ⌘C to copy");
  });
});
