import { AUTOPILOT_ACTIONS, AUTOPILOT_PRESETS, type Allow, type AutopilotAction } from "@lume/core/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { Available } from "@/lib/autopilot/types";
import { PermissionRows } from "./PermissionRows";

type P = Record<AutopilotAction, Allow>;
const STAGES = [
  { id: "s1", name: "Contacted", pipeline: "Sales" },
  { id: "s2", name: "Site visit booked", pipeline: "Sales" },
];
const ok: Available = { ok: true };
const allOk = Object.fromEntries(AUTOPILOT_ACTIONS.map((a) => [a, ok])) as Record<AutopilotAction, Available>;

let last: P = AUTOPILOT_PRESETS.balanced;
function Harness({
  start = AUTOPILOT_PRESETS.balanced,
  available,
}: {
  start?: P;
  available?: Record<AutopilotAction, Available>;
}) {
  const [v, setV] = useState(start);
  last = v;
  return (
    <PermissionRows
      value={v}
      onChange={setV}
      followUpDays={[2, 5]}
      stages={STAGES}
      {...(available ? { available } : {})}
    />
  );
}
const preset = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const row = (name: string) => screen.getByRole("radiogroup", { name });

/** What LUME AI may do (Autopilot spec 2026-10-19 §1.3): one set of rows for Settings and the start sheet (A3 Task 4). */
describe("PermissionRows", () => {
  it("a preset sets every row; changing one by hand unpresses them all", async () => {
    render(<Harness />);
    expect(preset("Balanced")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(preset("Hands-off"));
    expect(last).toEqual(AUTOPILOT_PRESETS.hands_off);
    await userEvent.click(within(row("Mark a lead lost")).getByRole("radio", { name: "Ask me" }));
    expect(last).toEqual({ ...AUTOPILOT_PRESETS.hands_off, mark_lost: "ask" });
    for (const p of ["Careful", "Balanced", "Hands-off"])
      expect(preset(p)).toHaveAttribute("aria-pressed", "false");
  });

  it("grouped, and named from the business's own setup", () => {
    render(<Harness />);
    for (const g of ["Messages", "Pipeline", "Careful"])
      expect(screen.getByRole("group", { name: g })).toBeInTheDocument();
    expect(screen.getByText("Day 2 and day 5, then stops")).toBeInTheDocument();
    expect(screen.getByText("Contacted → Site visit booked")).toBeInTheDocument();
    expect(screen.getByText(/Stop.* means stop/)).toBeInTheDocument();
  });

  it("an action the business can't use shows off, at Never, with why and where to set it up", async () => {
    const available = {
      ...allOk,
      answer_prices: {
        ok: false,
        why: "Add your price list in Settings → LUME AI.",
        fixHref: "/settings/ai",
      },
      book_meetings: { ok: false, why: "Needs a calendar LUME can book into.", fixHref: null },
    } as Record<AutopilotAction, Available>;
    render(<Harness start={AUTOPILOT_PRESETS.hands_off} available={available} />);
    const prices = row("Answer price questions");
    expect(within(prices).getByRole("radio", { name: "Never" })).toHaveAttribute("aria-checked", "true");
    for (const r of within(prices).getAllByRole("radio")) expect(r).toBeDisabled();
    expect(screen.getByText("Add your price list in Settings → LUME AI.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up prices" })).toHaveAttribute("href", "/settings/ai");
    expect(screen.getByText("Needs a calendar LUME can book into.")).toBeInTheDocument();
    // Pressing it does nothing: the choice underneath is kept for when it's set up.
    await userEvent.click(within(prices).getByRole("radio", { name: "Go ahead" }));
    expect(last.answer_prices).toBe("go");
    expect(within(row("Send first messages")).getByRole("radio", { name: "Go ahead" })).not.toBeDisabled();
  });

  it("the keyboard moves within a row, and Tab moves between rows", async () => {
    render(<Harness />);
    const first = within(row("Send first messages")).getByRole("radio", { name: "Go ahead" });
    first.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(last.first_messages).toBe("ask");
    expect(within(row("Send first messages")).getByRole("radio", { name: "Ask me" })).toHaveFocus();
    await userEvent.tab();
    expect(
      within(row("Follow up when there's no reply")).getByRole("radio", { name: "Go ahead" }),
    ).toHaveFocus();
  });
});
