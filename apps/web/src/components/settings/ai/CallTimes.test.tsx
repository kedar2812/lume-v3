import { DEFAULT_CALL_RULES, type CallRules } from "@lume/core/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { CallTimes } from "./CallTimes";

let last: CallRules = DEFAULT_CALL_RULES;
function Harness({ start = DEFAULT_CALL_RULES }: { start?: CallRules }) {
  const [v, setV] = useState(start);
  last = v;
  return <CallTimes value={v} onChange={setV} />;
}

/** Settings → LUME AI, the calls LUME AI may say yes to (spec 2026-11-02 LUME AI books calls). */
describe("calls LUME AI may say yes to", () => {
  it("none at first: it says a person confirms every call, and offers to add times", async () => {
    render(<Harness />);
    expect(screen.getByRole("heading", { name: "Calls LUME AI may say yes to" })).toBeInTheDocument();
    expect(screen.getByText(/With none, a person confirms every call/)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "A call is" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add times" }));
    expect(last.windows).toEqual([{ days: [1, 2, 3, 4, 5], from: "10:00", to: "18:00" }]);
    // With times, how long a call is and the notice show.
    expect(screen.getByRole("radiogroup", { name: "A call is" })).toBeInTheDocument();
  });

  it("days toggle by name, times change, a row comes off", async () => {
    render(
      <Harness start={{ ...DEFAULT_CALL_RULES, windows: [{ days: [1, 2], from: "10:00", to: "18:00" }] }} />,
    );
    const times = screen.getByRole("group", { name: "Call times 1" });
    const sat = within(times).getByRole("button", { name: "Saturday" });
    expect(sat).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(sat);
    expect(last.windows[0]!.days).toEqual([1, 2, 6]);
    await userEvent.click(within(times).getByRole("button", { name: "Monday" }));
    expect(last.windows[0]!.days).toEqual([2, 6]);
    fireEvent.change(within(times).getByLabelText("From"), { target: { value: "16:00" } });
    fireEvent.change(within(times).getByLabelText("To"), { target: { value: "19:30" } });
    expect(last.windows[0]).toMatchObject({ from: "16:00", to: "19:30" });
    await userEvent.click(within(times).getByRole("button", { name: "Remove call times 1" }));
    expect(last.windows).toEqual([]);
  });

  it("a call's length, the notice, how far ahead and how it happens", async () => {
    render(
      <Harness start={{ ...DEFAULT_CALL_RULES, windows: [{ days: [1], from: "10:00", to: "18:00" }] }} />,
    );
    await userEvent.click(
      within(screen.getByRole("radiogroup", { name: "A call is" })).getByRole("radio", { name: "45 min" }),
    );
    expect(last.minutes).toBe(45);
    fireEvent.change(screen.getByLabelText("Hours' notice, at least"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Days ahead, at most"), { target: { value: "7" } });
    await userEvent.type(screen.getByLabelText("How the call happens"), "We'll call you on WhatsApp.");
    expect(last).toMatchObject({ noticeHours: 4, daysAhead: 7, how: "We'll call you on WhatsApp." });
  });

  it("up to 14 rows", () => {
    const w = { days: [1], from: "10:00", to: "11:00" };
    render(<Harness start={{ ...DEFAULT_CALL_RULES, windows: Array.from({ length: 14 }, () => w) }} />);
    expect(screen.getByRole("button", { name: "Add times" })).toBeDisabled();
  });
});
