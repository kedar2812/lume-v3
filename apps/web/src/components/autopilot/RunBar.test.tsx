import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RunDetail } from "@/lib/autopilot/types";
import { RunBar } from "./RunBar";

const detail = (o: { status?: "running" | "paused" | "ended"; canControl?: boolean } = {}) =>
  ({
    run: {
      id: "r1",
      name: "Site visit booked · 50 leads",
      status: o.status ?? "running",
      pauseReason: o.status === "paused" ? "person" : null,
      canControl: o.canControl ?? true,
    },
    counts: {},
    leads: [],
    asks: [],
  }) as unknown as RunDetail;
const counts = { messaged: 10, replied: 4, ready: 1, stopped: 1, inRun: 50, done: 0.2 };
const bar = (o: Partial<Parameters<typeof RunBar>[0]> = {}) => {
  const p = {
    detail: detail(),
    status: { title: "LUME AI is working", line: null, working: true },
    counts,
    asks: 0,
    busy: false,
    onPause: vi.fn(),
    onResume: vi.fn(),
    onEnd: vi.fn(),
    onOpenAsks: vi.fn(),
    ...o,
  };
  render(<RunBar {...p} />);
  return p;
};

/** The run bar (Autopilot spec 2026-10-19 §2): what the run is doing, its counts, and the controls. */
describe("RunBar", () => {
  it("names the run and says what it's doing, with its counts", () => {
    bar();
    const region = screen.getByRole("region", { name: "Site visit booked · 50 leads" });
    expect(region).toHaveTextContent("LUME AI is working");
    const list = within(region).getByRole("list", { name: "This run so far" });
    for (const name of ["Messaged: 10", "Replied: 4", "Ready for you: 1", "Stopped: 1"])
      expect(within(list).getByRole("img", { name })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "10 of 50 messaged" })).toBeInTheDocument();
  });

  it("Pause while it runs; Resume when paused; End asks first", async () => {
    const p = bar();
    await userEvent.click(screen.getByRole("button", { name: "Pause (Esc)" }));
    expect(p.onPause).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "End run" }));
    const ask = screen.getByRole("dialog", { name: "End this run?" });
    expect(ask).toHaveTextContent("Nothing more is sent. Every lead keeps its conversation.");
    await userEvent.click(within(ask).getByRole("button", { name: "Keep it going" }));
    expect(p.onEnd).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "End run" }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "End this run?" })).getByRole("button", { name: "End run" }),
    );
    expect(p.onEnd).toHaveBeenCalledOnce();
  });

  it("paused: Resume, and the reason in words", async () => {
    const p = bar({
      detail: detail({ status: "paused" }),
      status: { title: "Paused", line: "Nothing is sent until you resume.", working: false },
    });
    expect(screen.getByText("Nothing is sent until you resume.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(p.onResume).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Pause (Esc)" })).toBeNull();
  });

  it("someone who didn't start it, and isn't an admin, watches without controls", () => {
    bar({ detail: detail({ canControl: false }) });
    expect(screen.queryByRole("button", { name: "Pause (Esc)" })).toBeNull();
    expect(screen.queryByRole("button", { name: "End run" })).toBeNull();
  });

  it("an ended run has no controls; things waiting for a tap say how many", async () => {
    const p = bar({ asks: 3 });
    await userEvent.click(screen.getByRole("button", { name: "3 waiting for you" }));
    expect(p.onOpenAsks).toHaveBeenCalledOnce();
  });
});
