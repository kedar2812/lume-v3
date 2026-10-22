import { AUTOPILOT_PRESETS, DEFAULT_AI_PROFILE, type AiProfile } from "@lume/core/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { StandingSection } from "./StandingSection";

type Standing = AiProfile["standing"];
const STAGES = [
  { id: "s1", name: "Contacted", pipeline: "Sales" },
  { id: "s2", name: "Site visit booked", pipeline: "Sales" },
  { id: "s3", name: "Design & quote shared", pipeline: "Sales" },
];
const SPEAKERS = [
  { id: "u1", name: "Priya Nair" },
  { id: "u2", name: "Rahul Mehta" },
];

let last: Standing = DEFAULT_AI_PROFILE.standing;
function Harness({ start = DEFAULT_AI_PROFILE.standing }: { start?: Standing }) {
  const [v, setV] = useState(start);
  last = v;
  return <StandingSection value={v} stages={STAGES} speakers={SPEAKERS} onChange={setV} />;
}
const preset = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const row = (name: string) => screen.getByRole("radiogroup", { name });

/** Settings → LUME AI, Standing choices (Autopilot spec 2026-10-19 §1.1–1.3, §3). */
describe("standing choices", () => {
  it("pressing a preset sets every row; changing one row unpresses it", async () => {
    render(<Harness />);
    expect(preset("Balanced")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(preset("Careful"));
    expect(last.permissions).toEqual(AUTOPILOT_PRESETS.careful);
    expect(preset("Careful")).toHaveAttribute("aria-pressed", "true");
    expect(within(row("Answer price questions")).getByRole("radio", { name: "Never" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await userEvent.click(within(row("Mark a lead lost")).getByRole("radio", { name: "Ask me" }));
    expect(last.permissions).toEqual({ ...AUTOPILOT_PRESETS.careful, mark_lost: "ask" });
    for (const p of ["Careful", "Balanced", "Hands-off"])
      expect(preset(p)).toHaveAttribute("aria-pressed", "false");
  });

  it("the rows are grouped and named in the business's words", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "Messages" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Pipeline" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Careful" })).toBeInTheDocument();
    // Its own stages, in order, name the stage moves.
    expect(screen.getByText("Contacted → Site visit booked → Design & quote shared")).toBeInTheDocument();
  });

  it("goal stages are the business's open stages, up to five", async () => {
    render(<Harness start={{ ...DEFAULT_AI_PROFILE.standing, goalStages: ["s2"] }} />);
    const goals = screen.getByRole("group", { name: "Goal stages" });
    expect(within(goals).getByRole("button", { name: "Site visit booked" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(goals).getByRole("button", { name: "Design & quote shared" }));
    expect(last.goalStages).toEqual(["s2", "s3"]);
    await userEvent.click(within(goals).getByRole("button", { name: "Site visit booked" }));
    expect(last.goalStages).toEqual(["s3"]);
  });

  it("who it speaks as: whoever starts the run, or one of the people who may send messages", async () => {
    render(<Harness />);
    const who = screen.getByRole("combobox", { name: "Speaks as" });
    expect(who).toHaveDisplayValue("Whoever starts the run");
    await userEvent.selectOptions(who, "Rahul Mehta");
    expect(last.speaker).toBe("u2");
  });

  it("follow-up days: added and removed, kept in order", async () => {
    render(<Harness />);
    const days = screen.getByRole("group", { name: "Follow up after" });
    expect(within(days).getByText("Day 2")).toBeInTheDocument();
    await userEvent.click(within(days).getByRole("button", { name: "Remove day 2" }));
    expect(last.followUpDays).toEqual([5]);
    await userEvent.selectOptions(within(days).getByRole("combobox", { name: "Add a follow-up day" }), "3");
    expect(last.followUpDays).toEqual([3, 5]);
  });

  it("a bot question is answered honestly or handed over; there's no choice to deny it", () => {
    render(<Harness />);
    const bot = screen.getByRole("radiogroup", { name: "If someone asks whether they're talking to a bot" });
    expect(
      within(bot)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Say so honestly", "Hand over to a person"]);
    expect(screen.getByRole("radiogroup", { name: "Replies outside working hours" })).toBeInTheDocument();
  });

  it("the daily cap follows the number's WhatsApp tier unless set", async () => {
    render(<Harness />);
    const own = screen.getByRole("switch", { name: "Set my own daily cap" });
    expect(own).toHaveAttribute("aria-checked", "false");
    await userEvent.click(own);
    expect(last.dailyCap).toBe(40);
    const cap = screen.getByRole("spinbutton", { name: "Messages a day, at most" });
    await userEvent.clear(cap);
    await userEvent.type(cap, "120");
    expect(last.dailyCap).toBe(120);
  });
});
