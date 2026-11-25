import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiBar, ARM_MS, type AiPhase } from "./AiBar";

const nothing = () => undefined;
const bar = (phase: AiPhase) => (
  <AiBar
    phase={phase}
    prompt="Say hello"
    onPrompt={nothing}
    selecting={false}
    doneWords="LUME AI built 1 step."
    beside={false}
    marked
    onBuild={nothing}
    onStop={nothing}
    onKeep={nothing}
    onDiscard={nothing}
  />
);
const wait = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it("Stop stays ready as the answer arrives and its steps start to land", async () => {
  const { rerender } = render(bar("asking"));
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  await wait(ARM_MS);
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  rerender(bar("playing"));
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  rerender(bar("done"));
  expect(screen.getByRole("button", { name: "Keep" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
});

it("a second build right after a first that failed at once waits its moment again", async () => {
  const { rerender } = render(bar("asking"));
  await wait(ARM_MS);
  rerender(bar("idle"));
  await wait(ARM_MS / 4);
  rerender(bar("asking"));
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  await wait(ARM_MS - 1);
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  await wait(1);
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
});
