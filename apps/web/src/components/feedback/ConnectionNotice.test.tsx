import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectionNotice } from "./ConnectionNotice";
import { createNetWatch } from "@/lib/network/watch";

// The words and the button, not the animation (as ToastProvider's tests): motion renders plainly here.
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

const setup = () => {
  const watch = createNetWatch(() => undefined);
  render(<ConnectionNotice watch={watch} />);
  return watch;
};

describe("the connection notice", () => {
  it("nothing while the connection is fine", () => {
    setup();
    expect(screen.queryByText(/offline|slow|online/i)).toBeNull();
  });

  it("offline: says so and that LUME reconnects by itself, with no button", () => {
    const w = setup();
    act(() => w.offline());
    expect(screen.getByText("You’re offline")).toBeInTheDocument();
    expect(screen.getByText("LUME reconnects by itself the moment it’s back.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("back: Back online", () => {
    const w = setup();
    act(() => {
      w.offline();
      w.online();
    });
    expect(screen.getByText("Back online")).toBeInTheDocument();
    expect(screen.queryByText("You’re offline")).toBeNull();
  });

  it("slow: says it's their connection, not LUME, and Dismiss puts it away", async () => {
    const w = setup();
    act(() => {
      for (const ms of [100, 2000, 2000, 2000]) w.trip(ms, 10);
    });
    expect(screen.getByText("Your internet is slow")).toBeInTheDocument();
    expect(screen.getByText("LUME is answering fast. Your connection is taking longer.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Your internet is slow")).toBeNull();
  });
});
