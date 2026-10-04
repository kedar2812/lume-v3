import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RangePicker } from "./RangePicker";

const TODAY = "2026-10-05";
const picker = (over: Partial<Parameters<typeof RangePicker>[0]> = {}) => {
  const onChange = vi.fn();
  render(<RangePicker choice="30d" compare today={TODAY} tz="Asia/Kolkata" onChange={onChange} {...over} />);
  return onChange;
};

describe("the range picker (canvas Main)", () => {
  it("the button says the range and what it's compared with; without Compare, only the range", () => {
    picker();
    expect(screen.getByRole("button", { name: /Last 30 days/ })).toHaveTextContent(
      "Last 30 daysvs the 30 before",
    );
  });

  it("opens with the presets, the month with the range drawn, the timezone and Compare", async () => {
    picker();
    await userEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
    const pop = screen.getByRole("dialog", { name: "Date range" });
    for (const p of [
      "Today",
      "Last 7 days",
      "Last 30 days",
      "This month",
      "Last month",
      "This quarter",
      "Last 12 months",
      "Custom…",
    ])
      expect(pop).toHaveTextContent(p);
    expect(screen.getByRole("button", { name: "Last 30 days" })).toHaveAttribute("aria-pressed", "true");
    expect(pop).toHaveTextContent("October 2026");
    expect(pop).toHaveTextContent("Times in Asia/Kolkata");
    expect(screen.getByRole("button", { name: "Monday, October 5" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Tuesday, October 6" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Compare with the period before" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("a preset picks and closes; Compare switches without closing", async () => {
    const onChange = picker();
    await userEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
    await userEvent.click(screen.getByRole("switch", { name: "Compare with the period before" }));
    expect(onChange).toHaveBeenCalledWith({ compare: false });
    await userEvent.click(screen.getByRole("button", { name: "Last 12 months" }));
    expect(onChange).toHaveBeenCalledWith({ choice: "12m" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("two days on the calendar make a custom range, in either order", async () => {
    const onChange = picker();
    await userEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
    await userEvent.click(screen.getByRole("button", { name: "Saturday, October 3" }));
    expect(screen.getByText("Now pick the last day.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Thursday, October 1" }));
    expect(onChange).toHaveBeenCalledWith({
      choice: "custom",
      custom: { from: "2026-10-01", to: "2026-10-03" },
    });
  });

  it("Esc closes and gives focus back to the button", async () => {
    picker();
    const button = screen.getByRole("button", { name: /Last 30 days/ });
    await userEvent.click(button);
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(button).toHaveFocus();
  });
});
