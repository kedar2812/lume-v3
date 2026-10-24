import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { GoalPicker, type GoalChoice } from "./GoalPicker";

const GOALS = [
  { kind: "stage" as const, stageId: "s2", name: "Site visit booked" },
  { kind: "stage" as const, stageId: "s4", name: "Quote shared" },
];
let last: GoalChoice;
function Harness({ start }: { start: GoalChoice }) {
  const [v, setV] = useState(start);
  last = v;
  return <GoalPicker goals={GOALS} value={v} onChange={setV} />;
}
const radio = (name: string) => screen.getByRole("radio", { name });

/** The goal (Autopilot spec 2026-10-19 §1.1): ready-made from the pipeline, Get a reply, or the business's own brief. */
describe("GoalPicker", () => {
  it("ready-made goals come from the business's own stages, and Get a reply", async () => {
    render(<Harness start={{ kind: "stage", stageId: "s2" }} />);
    expect(screen.getByText("Ready-made goals come from your pipeline")).toBeInTheDocument();
    expect(radio("Site visit booked")).toHaveAttribute("aria-checked", "true");
    await userEvent.click(radio("Get a reply"));
    expect(last).toEqual({ kind: "reply" });
    await userEvent.click(radio("Quote shared"));
    expect(last).toEqual({ kind: "stage", stageId: "s4" });
  });

  it("writing your own: Confirm stays off under 15 characters, then locks it in; Edit opens it again", async () => {
    render(<Harness start={{ kind: "reply" }} />);
    await userEvent.click(radio("Write your own"));
    const box = screen.getByRole("textbox", { name: "Your goal" });
    expect(screen.getByText("A good brief says the outcome, the offer and the tone")).toBeInTheDocument();
    await userEvent.type(box, "Book a call");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(last).toEqual({ kind: "brief", text: "Book a call", locked: false });
    await userEvent.type(box, " this week, please");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(last).toEqual({ kind: "brief", text: "Book a call this week, please", locked: true });
    expect(screen.getByText("Your goal is locked in. LUME AI writes from this.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Your goal" })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Edit your goal" }));
    expect(last).toMatchObject({ kind: "brief", locked: false });
    expect(screen.getByRole("textbox", { name: "Your goal" })).toHaveFocus();
  });

  it("Use an example fills the box with a sample that names no one's business; 600 characters at most", async () => {
    render(<Harness start={{ kind: "brief", text: "", locked: false }} />);
    await userEvent.click(screen.getByRole("button", { name: "Use an example" }));
    const box = screen.getByRole("textbox", { name: "Your goal" }) as HTMLTextAreaElement;
    expect(box.value.length).toBeGreaterThan(15);
    expect(box).toHaveAttribute("maxLength", "600");
    expect(screen.getByText(`${box.value.length} of 600`)).toBeInTheDocument();
  });

  it("no goal stages chosen yet: Get a reply and your own, with where to add ready-made ones", () => {
    render(<GoalPicker goals={[]} value={{ kind: "reply" }} onChange={() => undefined} />);
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Choose goal stages" })).toHaveAttribute("href", "/settings/ai");
  });

  it("arrow keys move between goals; only the chosen one is in the Tab order", async () => {
    render(<Harness start={{ kind: "stage", stageId: "s2" }} />);
    expect(radio("Site visit booked")).toHaveAttribute("tabindex", "0");
    expect(radio("Quote shared")).toHaveAttribute("tabindex", "-1");
    radio("Site visit booked").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(last).toEqual({ kind: "stage", stageId: "s4" });
    expect(radio("Quote shared")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(last).toEqual({ kind: "brief", text: "", locked: false });
  });
});
