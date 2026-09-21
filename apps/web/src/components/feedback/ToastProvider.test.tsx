import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./ToastProvider";

// These tests cover the provider's logic (timers, cap, actions, sound), not animation. Motion's exit
// animations run on requestAnimationFrame, which fake timers don't drive in jsdom, so render plainly.
vi.mock("motion/react", async () => {
  const { createElement, forwardRef } = await import("react");
  const strip = ({ initial, animate, exit, transition, layout, ...rest }: Record<string, unknown>) => (
    void initial,
    void animate,
    void exit,
    void transition,
    void layout,
    rest
  );
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        forwardRef((p: Record<string, unknown>, ref) => createElement(tag, { ...strip(p), ref })),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: unknown }) => children,
    useReducedMotion: () => true,
  };
});

const played: string[] = [];
vi.mock("./SoundProvider", () => ({
  useSound: () => ({ play: (c: string) => played.push(c), enabled: true, setEnabled() {} }),
}));

let api: ReturnType<typeof useToast>;
function Grab() {
  api = useToast();
  return null;
}
const setup = () =>
  render(
    <ToastProvider>
      <Grab />
    </ToastProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  played.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("toasts", () => {
  it("announces politely, plays its sound, and disappears after 4.2 s", () => {
    setup();
    act(() => void api.toast({ tone: "ok", title: "Follow-up done", detail: "Aisha Khan", sound: "done" }));
    expect(screen.getByRole("status")).toHaveTextContent("Follow-up done");
    expect(played).toEqual(["done"]);
    act(() => void vi.advanceTimersByTime(4300));
    act(() => void vi.runOnlyPendingTimers());
    expect(screen.queryByText("Follow-up done")).not.toBeInTheDocument();
  });

  it("runs the action (e.g. Undo) and closes", () => {
    setup();
    const undo = vi.fn();
    act(() => void api.toast({ title: "Moved to Won", action: { label: "Undo", onClick: undo } }));
    act(() => screen.getByRole("button", { name: "Undo" }).click());
    expect(undo).toHaveBeenCalledOnce();
    act(() => void vi.runOnlyPendingTimers());
    expect(screen.queryByText("Moved to Won")).not.toBeInTheDocument();
  });

  it("keeps at most three on screen", () => {
    setup();
    act(() => {
      for (const t of ["one", "two", "three", "four"]) api.toast({ title: t, durationMs: 60_000 });
    });
    expect(screen.queryByText("one")).not.toBeInTheDocument();
    expect(screen.getByText("four")).toBeInTheDocument();
  });

  it("is silent unless a sound is asked for", () => {
    setup();
    act(() => void api.toast({ title: "Snoozed until tomorrow" }));
    expect(played).toEqual([]);
  });
});
