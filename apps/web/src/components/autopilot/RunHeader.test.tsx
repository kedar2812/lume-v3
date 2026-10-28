import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RunDetail, RunsList } from "@/lib/autopilot/types";
import { RunHeader } from "./RunHeader";

const run = (o: Partial<RunDetail["run"]> = {}) =>
  ({
    id: "r1",
    name: "October enquiries",
    status: "running",
    pauseReason: null,
    canControl: true,
    ...o,
  }) as RunDetail["run"];
const runs = [
  { id: "r1", name: "October enquiries", status: "running" },
  { id: "r2", name: "Old leads", status: "ended" },
] as RunsList["runs"];
const props = (o: Partial<Parameters<typeof RunHeader>[0]> = {}) => ({
  run: run(),
  line: { text: "LUME AI is following up with 24 leads · 16 messaged · 7 replied", working: true },
  busy: false,
  canStart: true,
  runs: runs.slice(0, 1),
  onRun: vi.fn(),
  onPause: vi.fn(),
  onResume: vi.fn(),
  onEnd: vi.fn(),
  ...o,
});

/** The LUME AI page's header (plan 2026-10-28, artboard 1): the run, where it stands in one line, and what you'd do. */
describe("RunHeader", () => {
  it("the run's name, and one line of where things stand, the Loop drawing only while LUME AI works", () => {
    const { container, rerender } = render(<RunHeader {...props()} />);
    expect(screen.getByRole("heading", { name: "October enquiries", level: 2 })).toBeInTheDocument();
    expect(
      screen.getByText("LUME AI is following up with 24 leads · 16 messaged · 7 replied"),
    ).toBeInTheDocument();
    expect(container.querySelector("[data-draw='pen']")).not.toBeNull();
    rerender(
      <RunHeader {...props({ line: { text: "Following up with 3 leads · 3 messaged", working: false } })} />,
    );
    expect(container.querySelector("[data-draw]")).toBeNull();
  });

  it("Pause all with Esc while it runs; Resume when paused; End run asks first", async () => {
    const p = props();
    const { rerender } = render(<RunHeader {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Pause all (Esc)" }));
    expect(p.onPause).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "End run" }));
    const ask = screen.getByRole("dialog", { name: "End this run?" });
    expect(ask).toHaveTextContent("Nothing more is sent. Every lead keeps its conversation.");
    expect(p.onEnd).not.toHaveBeenCalled();
    await userEvent.click(within(ask).getByRole("button", { name: "End run" }));
    expect(p.onEnd).toHaveBeenCalledOnce();
    rerender(<RunHeader {...p} run={run({ status: "paused", pauseReason: "person" })} />);
    expect(screen.queryByRole("button", { name: "Pause all (Esc)" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(p.onResume).toHaveBeenCalledOnce();
  });

  it("someone who doesn't control the run, or one that's ended: no controls", () => {
    const { rerender } = render(<RunHeader {...props({ run: run({ canControl: false }) })} />);
    expect(screen.queryByRole("button", { name: "Pause all (Esc)" })).toBeNull();
    expect(screen.queryByRole("button", { name: "End run" })).toBeNull();
    rerender(<RunHeader {...props({ run: run({ status: "ended" }) })} />);
    expect(screen.queryByRole("button", { name: "Pause all (Esc)" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("New run goes to Leads, for whoever may start one", () => {
    const { rerender } = render(<RunHeader {...props()} />);
    expect(screen.getByRole("link", { name: "New run" })).toHaveAttribute("href", "/leads");
    rerender(<RunHeader {...props({ canStart: false })} />);
    expect(screen.queryByRole("link", { name: "New run" })).toBeNull();
  });

  it("several runs: one to choose, each saying how it is", async () => {
    const onRun = vi.fn();
    render(<RunHeader {...props({ runs, onRun })} />);
    const pick = screen.getByRole("combobox", { name: "Run" });
    expect(
      within(pick)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["October enquiries · going", "Old leads · done"]);
    await userEvent.selectOptions(pick, "r2");
    expect(onRun).toHaveBeenCalledWith("r2");
  });
});
