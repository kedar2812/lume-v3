import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_WHATS_NEW, type StoryId } from "@lume/core/shared";
import { fakeSession } from "@/server/session";
import { WhatsNewProvider, useWhatsNew } from "./WhatsNewProvider";

let path = "/today";
const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => path, useRouter: () => ({ push }) }));
let reduced = false;
vi.mock("motion/react", async (orig) => ({
  ...(await orig<typeof import("motion/react")>()),
  useReducedMotion: () => reduced,
}));

const save = vi.fn(async (p: { seen?: string }) => ({ ...EMPTY_WHATS_NEW, seen: p.seen ?? null }));
const client = { save };

const ALL: StoryId[] = ["calls", "chats", "templates"];
function sessionWith(stories: StoryId[] = ALL, due = true) {
  return fakeSession({
    whatsNew: { version: "1.2.0", stories, state: EMPTY_WHATS_NEW },
    flags: {
      needsAgreement: false,
      needsOnboarding: false,
      needsTwoFactorEnrolment: false,
      needsTour: false,
      needsWhatsNew: due,
    },
  });
}
function Opener() {
  const w = useWhatsNew();
  return (
    <button type="button" onClick={() => w.open()}>
      Open it
    </button>
  );
}
const mount = (session = sessionWith(), extra: ReactNode = null) =>
  render(
    <WhatsNewProvider session={session} client={client}>
      <button type="button">Behind</button>
      <Opener />
      {extra}
    </WhatsNewProvider>,
  );
const win = () => screen.queryByRole("dialog", { name: "What's new in 1.2.0" });
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
/** Past the opening: the version's roll and its leaving. */
const OVERTURE_MS = 3300;

beforeEach(() => {
  vi.useFakeTimers();
  path = "/today";
  reduced = false;
  save.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("What's new: the window", () => {
  it("opens once when due, and is kept as seen", () => {
    const { rerender } = mount();
    expect(win()).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ seen: "1.2.0" });
    fireEvent.keyDown(win()!, { key: "Escape" });
    tick(600);
    expect(win()).not.toBeInTheDocument();
    // The same session again (no reload yet): it never opens twice.
    rerender(
      <WhatsNewProvider session={sessionWith()} client={client}>
        <button type="button">Behind</button>
      </WhatsNewProvider>,
    );
    expect(win()).not.toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("isn't opened when nothing is due, or there's nothing for this person", () => {
    mount(sessionWith(ALL, false));
    expect(win()).not.toBeInTheDocument();
  });

  it("waits while a sheet is open, and opens once it closes", async () => {
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    document.body.appendChild(sheet);
    mount();
    expect(win()).not.toBeInTheDocument();
    await act(async () => {
      sheet.remove();
    });
    expect(win()).toBeInTheDocument();
  });

  it("never opens in the middle of setup, onboarding or an import", () => {
    for (const p of ["/onboarding", "/setup", "/settings/imports/abc"]) {
      path = p;
      const { unmount } = mount();
      expect(win()).not.toBeInTheDocument();
      unmount();
    }
  });

  it("the rail holds this person's stories; arrows and Next move; the last one's Done closes", () => {
    mount();
    tick(OVERTURE_MS);
    const rail = within(win()!).getByRole("navigation", { name: "This update" });
    expect(
      within(rail)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      expect.stringContaining("LUME AI books your calls"),
      expect.stringContaining("Your chats, live in LUME"),
      expect.stringContaining("Templates, written for you"),
    ]);
    expect(within(win()!).getByText("1 of 3")).toBeInTheDocument();
    fireEvent.keyDown(win()!, { key: "ArrowRight" });
    expect(within(win()!).getByText("2 of 3")).toBeInTheDocument();
    fireEvent.click(within(win()!).getByRole("button", { name: "Next" }));
    expect(within(win()!).getByText("3 of 3")).toBeInTheDocument();
    fireEvent.keyDown(win()!, { key: "ArrowLeft" });
    fireEvent.click(within(rail).getAllByRole("button")[2]!);
    fireEvent.click(within(win()!).getByRole("button", { name: "Done" }));
    tick(600);
    expect(win()).not.toBeInTheDocument();
  });

  it("only the stories this person may see", () => {
    mount(sessionWith(["chats", "templates"]));
    tick(OVERTURE_MS);
    const rail = within(win()!).getByRole("navigation", { name: "This update" });
    expect(within(rail).getAllByRole("button")).toHaveLength(2);
    expect(within(win()!).getByText("1 of 2")).toBeInTheDocument();
    expect(within(win()!).queryByText(/books/)).not.toBeInTheDocument();
  });

  it("plays by itself: after a story's time, the next", () => {
    mount();
    tick(OVERTURE_MS);
    expect(within(win()!).getByText("1 of 3")).toBeInTheDocument();
    tick(8500);
    expect(within(win()!).getByText("2 of 3")).toBeInTheDocument();
  });

  it("with reduced motion: no opening roll, and nothing moves by itself", () => {
    reduced = true;
    mount();
    expect(within(win()!).queryByText("What's new in LUME")).not.toBeInTheDocument();
    expect(within(win()!).getByText("1 of 3")).toBeInTheDocument();
    tick(20_000);
    expect(within(win()!).getByText("1 of 3")).toBeInTheDocument();
  });

  it("the app behind is out of reach while it's open; Esc closes it and focus goes back", () => {
    mount(sessionWith(ALL, false));
    const opener = screen.getByRole("button", { name: "Open it" });
    opener.focus();
    fireEvent.click(opener);
    expect(win()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Behind", hidden: true }).closest("[inert]")).not.toBeNull();
    fireEvent.keyDown(win()!, { key: "Escape" });
    tick(600);
    expect(win()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Behind" }).closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("focus starts on the window itself, never ringing the Close button as it opens", () => {
    mount();
    expect(document.activeElement).toBe(win());
  });

  it("lists the smaller changes under Also new", () => {
    mount();
    tick(OVERTURE_MS);
    for (const line of [
      "The two-step code is ready to type, no click first",
      "Lift do not contact from LUME AI's chat",
      "Delete your own account, from My account",
      "Profile photos save from every browser",
    ])
      expect(within(win()!).getByText(line)).toBeInTheDocument();
  });
});
