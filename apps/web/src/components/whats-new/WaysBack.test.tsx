import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_WHATS_NEW, type StoryId, type WhatsNewState } from "@lume/core/shared";
import { ProfileMenu } from "@/components/shell/ProfileMenu";
import { fakeSession } from "@/server/session";
import { AboutWhatsNew } from "./AboutWhatsNew";
import { AgainPill } from "./AgainPill";
import { WhatsNewProvider } from "./WhatsNewProvider";

vi.mock("next/navigation", () => ({ usePathname: () => "/today", useRouter: () => ({ push: vi.fn() }) }));
let reduced = false;
vi.mock("motion/react", async (orig) => ({
  ...(await orig<typeof import("motion/react")>()),
  useReducedMotion: () => reduced,
}));

let stored: WhatsNewState = EMPTY_WHATS_NEW;
const save = vi.fn(async (p: { seen?: string; pillGone?: string }) => {
  stored = {
    ...stored,
    ...(p.seen ? { seen: p.seen } : {}),
    ...(p.pillGone ? { pillGone: p.pillGone } : {}),
  };
  return stored;
});

function sessionWith(
  o: { stories?: StoryId[]; version?: string; due?: boolean; state?: WhatsNewState } = {},
) {
  return fakeSession({
    whatsNew: {
      version: o.version ?? "1.2.0",
      stories: o.stories ?? ["calls", "chats", "templates"],
      state: o.state ?? EMPTY_WHATS_NEW,
    },
    flags: {
      needsAgreement: false,
      needsOnboarding: false,
      needsTwoFactorEnrolment: false,
      needsTour: false,
      needsWhatsNew: o.due ?? false,
    },
  });
}
const mount = (child: ReactNode, session = sessionWith()) =>
  render(
    <WhatsNewProvider session={session} client={{ save }}>
      {child}
    </WhatsNewProvider>,
  );
const win = () => screen.queryByRole("dialog", { name: "What's new in 1.2.0" });
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const SEEN = { ...EMPTY_WHATS_NEW, seen: "1.2.0" };

beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  stored = EMPTY_WHATS_NEW;
  save.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("Today's pill", () => {
  it("arrives once the window is closed, and opens it again with the whole opening", async () => {
    mount(<AgainPill />, sessionWith({ due: true }));
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "What's new in version 1.2.0", hidden: true })).toBeNull();
    fireEvent.keyDown(win()!, { key: "Escape" });
    tick(600);
    const go = screen.getByRole("button", { name: "What's new in version 1.2.0" });
    expect(go.querySelector('img[src="/lume-mark.png"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Hide What's new in version 1.2.0" })).toBeInTheDocument();
    fireEvent.click(go);
    expect(within(win()!).getByText("What's new in LUME")).toBeInTheDocument();
  });

  it("its X puts it away for good, for this version", async () => {
    const view = mount(<AgainPill />, sessionWith({ state: SEEN }));
    fireEvent.click(screen.getByRole("button", { name: "Hide What's new in version 1.2.0" }));
    expect(screen.queryByRole("button", { name: "What's new in version 1.2.0" })).toBeNull();
    await act(async () => undefined);
    expect(save).toHaveBeenCalledWith({ pillGone: "1.2.0" });
    view.unmount();
    mount(<AgainPill />, sessionWith({ state: { ...SEEN, pillGone: "1.2.0" } }));
    expect(screen.queryByRole("button", { name: "What's new in version 1.2.0" })).toBeNull();
  });

  it("isn't there before the window was seen", () => {
    mount(<AgainPill />);
    expect(screen.queryByRole("button", { name: "What's new in version 1.2.0" })).toBeNull();
  });
});

describe("Settings → About", () => {
  it("a button with this version's stories as chips, opening the window with the full roll", () => {
    mount(<AboutWhatsNew />, sessionWith({ state: SEEN, stories: ["chats", "templates"] }));
    const go = screen.getByRole("button", { name: /What's new in version 1\.2\.0/ });
    expect(within(go).getAllByTestId("chip")).toHaveLength(2);
    fireEvent.click(go);
    expect(within(win()!).getByText("What's new in LUME")).toBeInTheDocument();
  });

  it("still under reduced motion: every chip there, nothing waiting to appear", () => {
    reduced = true;
    mount(<AboutWhatsNew />, sessionWith({ state: SEEN }));
    expect(screen.getByRole("button", { name: /What's new in version 1\.2\.0/ })).toHaveAttribute(
      "data-still",
    );
  });
});

describe("the profile menu", () => {
  it("What's new opens the window", () => {
    mount(<ProfileMenu user={{ name: "Riya Sharma", role: "Sales" }} />, sessionWith({ state: SEEN }));
    fireEvent.click(screen.getByRole("button", { name: /Riya Sharma/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "What's new" }));
    expect(win()).toBeInTheDocument();
  });
});

describe("with nothing to tell", () => {
  it("none of the ways back show without a release, or without a story for this person", () => {
    for (const session of [
      sessionWith({ version: "", state: SEEN }),
      sessionWith({ stories: [], state: SEEN }),
    ]) {
      const view = mount(
        <>
          <AgainPill />
          <AboutWhatsNew />
          <ProfileMenu user={{ name: "Riya Sharma", role: "Sales" }} />
        </>,
        session,
      );
      expect(screen.queryByRole("button", { name: /What's new in version/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Riya Sharma/ }));
      expect(screen.queryByRole("menuitem", { name: "What's new" })).toBeNull();
      view.unmount();
    }
  });
});
