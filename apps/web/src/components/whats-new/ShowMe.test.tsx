import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_WHATS_NEW, RELEASES, type StoryId } from "@lume/core/shared";
import { cardPosition } from "@/lib/spotlight";
import { fakeSession } from "@/server/session";
import { SHOW_ME_WAIT_MS, ShowMe, TIP } from "./ShowMe";
import { WhatsNewProvider } from "./WhatsNewProvider";

const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/today", useRouter: () => ({ push }) }));
vi.mock("motion/react", async (orig) => ({
  ...(await orig<typeof import("motion/react")>()),
  useReducedMotion: () => true,
}));

const save = vi.fn(async () => EMPTY_WHATS_NEW);
const calls = RELEASES[0]!.stories.find((s) => s.id === "calls")!;
const ALL: StoryId[] = ["calls", "chats", "templates"];
const session = fakeSession({
  whatsNew: { version: "1.2.0", stories: ALL, state: EMPTY_WHATS_NEW },
  flags: {
    needsAgreement: false,
    needsOnboarding: false,
    needsTwoFactorEnrolment: false,
    needsTour: false,
    needsWhatsNew: true,
  },
});
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const win = () => screen.queryByRole("dialog", { name: "What's new in 1.2.0" });
const tip = () => screen.queryByRole("dialog", { name: calls.tip.title });

function target(id: string, r: { top: number; left: number; width: number; height: number }) {
  const el = document.createElement("div");
  el.dataset.whatsnew = id;
  el.getBoundingClientRect = () => ({
    ...r,
    bottom: r.top + r.height,
    right: r.left + r.width,
    x: r.left,
    y: r.top,
    toJSON: () => r,
  });
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
  push.mockClear();
  save.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll("[data-whatsnew]").forEach((el) => el.remove());
});

describe("Show me", () => {
  it("takes them to the story's place, keeps it as used, and points at it once it's there", () => {
    render(
      <WhatsNewProvider session={session} client={{ save }}>
        <main />
      </WhatsNewProvider>,
    );
    fireEvent.click(within(win()!).getByRole("button", { name: "Show me" }));
    expect(win()).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/settings/ai");
    expect(save).toHaveBeenCalledWith({ used: "calls" });
    expect(tip()).not.toBeInTheDocument();
    target("calls", { top: 200, left: 300, width: 400, height: 120 });
    tick(150);
    expect(within(tip()!).getByText(calls.tip.body)).toBeInTheDocument();
    expect(within(tip()!).getByRole("button", { name: "Got it" })).toBeInTheDocument();
    // The veil has its hole over the control (the tour's own Spotlight).
    expect(screen.getByTestId("tour-veil").style.clipPath).toContain("path(");
  });

  it("Back to What's new opens the window again on the same story, without the opening", () => {
    render(
      <WhatsNewProvider session={session} client={{ save }}>
        <main />
      </WhatsNewProvider>,
    );
    fireEvent.keyDown(win()!, { key: "ArrowRight" });
    fireEvent.keyDown(win()!, { key: "ArrowRight" });
    fireEvent.click(within(win()!).getByRole("button", { name: "Show me" }));
    expect(push).toHaveBeenCalledWith("/templates");
    target("write-with-ai", { top: 100, left: 100, width: 160, height: 40 });
    tick(150);
    fireEvent.click(screen.getByRole("button", { name: "Back to What's new" }));
    expect(win()).toBeInTheDocument();
    expect(within(win()!).getByText("3 of 3")).toBeInTheDocument();
    expect(within(win()!).queryByText("What's new in LUME")).not.toBeInTheDocument();
  });

  it("Got it puts the tip away", () => {
    const done = vi.fn();
    target("calls", { top: 200, left: 300, width: 400, height: 120 });
    render(<ShowMe story={calls} onGotIt={done} onBack={() => undefined} />);
    tick(150);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(done).toHaveBeenCalled();
  });

  it("a place that never shows its control: the tip waits 3 s, then sits in the middle with no ring", () => {
    render(<ShowMe story={calls} onGotIt={() => undefined} onBack={() => undefined} />);
    tick(SHOW_ME_WAIT_MS - 200);
    expect(tip()).not.toBeInTheDocument();
    tick(300);
    expect(tip()).toHaveAttribute("data-centred");
    expect(screen.getByTestId("tour-veil").style.clipPath).toBe("");
  });

  it("a control that's there but hidden at this width is never pointed at", () => {
    const el = target("calls", { top: 0, left: 0, width: 0, height: 0 });
    el.checkVisibility = () => false;
    render(<ShowMe story={calls} onGotIt={() => undefined} onBack={() => undefined} />);
    tick(SHOW_ME_WAIT_MS + 100);
    expect(tip()).toHaveAttribute("data-centred");
    expect(screen.getByTestId("tour-veil").style.clipPath).toBe("");
  });

  it("below the control when there's room, above it when there isn't", () => {
    const vp = { width: window.innerWidth, height: window.innerHeight };
    const low = { top: vp.height - 90, left: 300, width: 300, height: 60 };
    target("calls", low);
    render(<ShowMe story={calls} onGotIt={() => undefined} onBack={() => undefined} />);
    tick(150);
    const at = cardPosition(low, "bottom", TIP, vp);
    expect(at.top + TIP.height).toBeLessThanOrEqual(low.top);
    expect(tip()!.style.top).toBe(`${at.top}px`);
    expect(tip()!.style.left).toBe(`${at.left}px`);
  });
});
