import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunLead } from "@/lib/autopilot/types";
import { TypingComposer } from "./TypingComposer";

const T0 = new Date("2026-10-26T09:00:00.000Z");
const TEXT = "Hi Meera, thanks for your enquiry. Can we help?";
const draft = (o: Partial<NonNullable<RunLead["draft"]>> = {}): NonNullable<RunLead["draft"]> => ({
  text: TEXT,
  kind: "template",
  templateName: "First hello",
  startedAt: T0.toISOString(),
  revealedBy: new Date(T0.getTime() + 4000).toISOString(),
  marks: [[3, 8]],
  ...o,
});
const shownText = () => screen.getByTestId("typing").textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

/** LUME AI typing in the open (Autopilot spec 2026-10-19 §2): watched live, frozen by Pause, taken over by a click. */
describe("TypingComposer", () => {
  it("types the message at reading speed, whole words, until it's all there", () => {
    render(
      <TypingComposer
        leadName="Meera Iyer"
        speaker="Priya Nair"
        draft={draft()}
        frozenAt={null}
        onTakeOver={vi.fn()}
      />,
    );
    expect(shownText()).toBe("");
    act(() => void vi.advanceTimersByTime(2000));
    const half = shownText();
    expect(half.length).toBeGreaterThan(0);
    expect(TEXT.startsWith(half)).toBe(true);
    act(() => void vi.advanceTimersByTime(2500));
    expect(shownText()).toBe(TEXT);
    expect(screen.getByText("LUME AI is writing as Priya Nair")).toBeInTheDocument();
    expect(screen.getByText("Approved template · First hello")).toBeInTheDocument();
  });

  it("a template's filled values are highlighted as they appear", () => {
    vi.setSystemTime(new Date(T0.getTime() + 5000));
    render(
      <TypingComposer
        leadName="Meera Iyer"
        speaker="Priya Nair"
        draft={draft()}
        frozenAt={null}
        onTakeOver={vi.fn()}
      />,
    );
    expect([...document.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Meera"]);
  });

  it("Pause freezes it where it was: nothing more appears", () => {
    const frozen = new Date(T0.getTime() + 1500);
    render(
      <TypingComposer
        leadName="Meera Iyer"
        speaker="Priya Nair"
        draft={draft()}
        frozenAt={frozen}
        onTakeOver={vi.fn()}
      />,
    );
    act(() => void vi.advanceTimersByTime(1500));
    const at = shownText();
    act(() => void vi.advanceTimersByTime(5000));
    expect(shownText()).toBe(at);
    expect(at.length).toBeLessThan(TEXT.length);
  });

  it("clicking the message takes the lead over; a person who can't sees no such button", async () => {
    vi.useRealTimers();
    const onTakeOver = vi.fn();
    const { unmount } = render(
      <TypingComposer
        leadName="Meera Iyer"
        speaker="Priya Nair"
        draft={draft()}
        frozenAt={null}
        onTakeOver={onTakeOver}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Take over Meera: type your own message" }));
    expect(onTakeOver).toHaveBeenCalledOnce();
    expect(screen.getByText("Click the message to take over this lead")).toBeInTheDocument();
    unmount();
    render(<TypingComposer leadName="Meera Iyer" speaker="Priya Nair" draft={draft()} frozenAt={null} />);
    expect(screen.queryByRole("button", { name: /Take over/ })).toBeNull();
  });

  it("a screen reader hears the whole message once, not each word", () => {
    render(
      <TypingComposer
        leadName="Meera Iyer"
        speaker="Priya Nair"
        draft={draft()}
        frozenAt={null}
        onTakeOver={vi.fn()}
      />,
    );
    expect(screen.getByTestId("typing")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(`LUME AI's message to Meera: ${TEXT}`)).toBeInTheDocument();
  });
});
