import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TOUR_STEPS, TOUR_VERSION } from "@lume/core/shared";
import { fakeSession } from "@/server/session";
import { TourProvider, useTour } from "./TourProvider";

const targets = (ids: string[]) => (
  <>
    {ids.map((id) => (
      <button key={id} data-tour={id}>
        {id}
      </button>
    ))}
  </>
);
const client = () => ({
  saveStep: vi.fn(async () => {}),
  complete: vi.fn(async () => {}),
  skip: vi.fn(async () => {}),
});
const everyone = ["brand", "nav-today", "search", "notifications", "nav-settings", "profile"];

describe("the spotlight tour", () => {
  it("walks the steps, bolding module names, and records where it got to", async () => {
    const c = client();
    const session = fakeSession({ permissions: [{ key: "leads.view", scope: "own" }] });
    render(
      <TourProvider session={session} client={c} autoStart>
        {targets(["brand", "nav-today", "nav-leads", "search", "notifications", "nav-settings", "profile"])}
      </TourProvider>,
    );
    const dialog = await screen.findByRole("dialog", { name: /tour/i });
    expect(dialog).toHaveTextContent("This is LUME");
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(dialog).toHaveTextContent("Start on Today");
    expect(dialog.querySelector("strong")).toHaveTextContent("Today"); // bold, and not HTML from the string
    expect(c.saveStep).toHaveBeenCalledWith(1);
    await userEvent.keyboard("{ArrowLeft}");
    expect(dialog).toHaveTextContent("This is LUME");
    await userEvent.keyboard("{ArrowRight}");
    expect(dialog).toHaveTextContent("Start on Today");
  });

  it("finishes at the end and never asks again", async () => {
    const c = client();
    render(
      <TourProvider session={fakeSession({ permissions: [] })} client={c} autoStart>
        {targets(everyone)}
      </TourProvider>,
    );
    const total = TOUR_STEPS.filter((s) => s.permission === null && !s.needsCapability).length;
    await screen.findByRole("dialog", { name: /tour/i });
    expect(screen.getByText(`1 of ${total}`)).toBeInTheDocument();
    for (let i = 0; i < total - 1; i++) await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(c.complete).toHaveBeenCalled();
    expect(c.skip).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /tour/i })).not.toBeInTheDocument();
  });

  it("records a skip when Escape is pressed, or Skip tour is clicked", async () => {
    const c = client();
    const { unmount } = render(
      <TourProvider session={fakeSession({ permissions: [] })} client={c} autoStart>
        {targets(everyone)}
      </TourProvider>,
    );
    await screen.findByRole("dialog", { name: /tour/i });
    await userEvent.keyboard("{Escape}");
    expect(c.skip).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: /tour/i })).not.toBeInTheDocument();
    unmount();
    render(
      <TourProvider session={fakeSession({ permissions: [] })} client={c} autoStart>
        {targets(everyone)}
      </TourProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Skip tour" }));
    expect(c.skip).toHaveBeenCalledTimes(2);
  });

  it("skips a step whose target is missing instead of pointing at nothing", async () => {
    render(
      <TourProvider session={fakeSession({ permissions: [] })} client={client()} autoStart>
        {targets(["brand", "search", "notifications", "nav-settings", "profile"])}
      </TourProvider>,
    );
    const dialog = await screen.findByRole("dialog", { name: /tour/i });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(dialog).not.toHaveTextContent("Start on Today"); // nav-today isn't rendered here
    expect(dialog).toHaveTextContent("Jump anywhere");
  });

  it("does not start on its own when the person has already seen it, but can be replayed", async () => {
    function Replay() {
      const { start } = useTour();
      return (
        <button type="button" onClick={start}>
          Replay
        </button>
      );
    }
    render(
      <TourProvider
        session={fakeSession({
          tour: { version: TOUR_VERSION, step: 3, completedAt: "2026-09-20T10:00:00Z", skippedAt: null },
        })}
        client={client()}
        autoStart
      >
        {targets(everyone)}
        <Replay />
      </TourProvider>,
    );
    expect(screen.queryByRole("dialog", { name: /tour/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(await screen.findByRole("dialog", { name: /tour/i })).toHaveTextContent("This is LUME");
  });

  it("starts when onboarding hands over with ?tour=1, and tidies the address", async () => {
    window.history.replaceState(null, "", "/today?tour=1");
    render(
      <TourProvider
        session={fakeSession({
          tour: { version: TOUR_VERSION, step: 0, completedAt: null, skippedAt: "2026-09-20T10:00:00Z" },
        })}
        client={client()}
        autoStart
      >
        {targets(everyone)}
      </TourProvider>,
    );
    expect(await screen.findByRole("dialog", { name: /tour/i })).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("picks up a tour that was left half-way, but a replay starts again", async () => {
    function Replay() {
      const { start } = useTour();
      return (
        <button type="button" onClick={start}>
          Replay
        </button>
      );
    }
    render(
      <TourProvider
        session={fakeSession({
          permissions: [],
          tour: { version: TOUR_VERSION, step: 2, completedAt: null, skippedAt: null },
        })}
        client={client()}
        autoStart
      >
        {targets(everyone)}
        <Replay />
      </TourProvider>,
    );
    expect(await screen.findByRole("dialog", { name: /tour/i })).toHaveTextContent("Jump anywhere");
    await userEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(screen.getByRole("dialog", { name: /tour/i })).toHaveTextContent("This is LUME");
  });

  it("does nothing at all when no target exists", async () => {
    const c = client();
    render(
      <TourProvider session={fakeSession({ permissions: [] })} client={c} autoStart>
        <p>no shell here</p>
      </TourProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog", { name: /tour/i })).not.toBeInTheDocument();
    expect(c.skip).not.toHaveBeenCalled();
  });
});
