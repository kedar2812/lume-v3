import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiClient } from "@/lib/ai/client";
import { autopilotClient, type LeadStanding } from "@/lib/autopilot/client";
import { HandToAi } from "./HandToAi";

vi.mock("@/lib/ai/client", () => ({ aiClient: { status: vi.fn() } }));
vi.mock("@/lib/autopilot/client", () => ({
  autopilotClient: { leadState: vi.fn(), carryOn: vi.fn(), handBack: vi.fn() },
}));
vi.mock("@/lib/notifications/stream", () => ({ useAutopilot: () => undefined }));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
vi.mock("./StartSheet", () => ({
  StartSheet: (p: { target: { leadIds: string[] }; onStarted(): void }) => (
    <div role="dialog" aria-label="Start sheet">
      {p.target.leadIds.join(",")}
      <button type="button" onClick={p.onStarted}>
        Start
      </button>
    </div>
  ),
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const stands = (s: LeadStanding, on = true) => {
  vi.mocked(aiClient.status).mockResolvedValue(ok({ on }) as never);
  vi.mocked(autopilotClient.leadState).mockResolvedValue(ok(s) as never);
};
const RUN = { id: "run1", status: "running" as const };
const show = (canStart = true) =>
  render(<HandToAi leadId="L1" leadName="Mrunal Desale" canStart={canStart} />);

describe("Let LUME AI handle this, wherever the lead is (2026-11-01)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("not in a run: the start sheet for this one lead; started, LUME says so", async () => {
    stands({ run: null });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Let LUME AI handle Mrunal" }));
    expect(screen.getByRole("dialog", { name: "Start sheet" })).toHaveTextContent("L1");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "LUME AI has Mrunal now" }));
  });

  it("ready for a person, or waiting on one: Let LUME AI carry on, for the run's controllers only", async () => {
    stands({ run: RUN, state: "ready", canDecide: true });
    vi.mocked(autopilotClient.carryOn).mockResolvedValue(ok({ leadId: "L1", state: "replied" }) as never);
    const { unmount } = show();
    await userEvent.click(await screen.findByRole("button", { name: "Let LUME AI carry on" }));
    expect(autopilotClient.carryOn).toHaveBeenCalledWith("run1", "L1");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "LUME AI is back with Mrunal" }));
    unmount();
    stands({ run: RUN, state: "needs_you", canDecide: false });
    show();
    await waitFor(() => expect(autopilotClient.leadState).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("taken over: hand it back; already working it: says so, a link to watch", async () => {
    stands({ run: RUN, state: "with_you", canDecide: false });
    vi.mocked(autopilotClient.handBack).mockResolvedValue(ok({ leadId: "L1", state: "talking" }) as never);
    const { unmount } = show();
    await userEvent.click(await screen.findByRole("button", { name: "Hand back to LUME AI" }));
    expect(autopilotClient.handBack).toHaveBeenCalledWith("run1", "L1");
    unmount();
    stands({ run: RUN, state: "talking", canDecide: true });
    show();
    expect(await screen.findByRole("link", { name: "LUME AI is on it" })).toHaveAttribute(
      "href",
      "/autopilot?run=run1",
    );
  });

  it("LUME AI off, someone who can't start it, or a refusal: nothing to press, or said in words", async () => {
    stands({ run: null }, false);
    const { unmount } = show();
    await waitFor(() => expect(aiClient.status).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    stands({ run: null });
    const again = show(false);
    await waitFor(() => expect(autopilotClient.leadState).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
    again.unmount();
    stands({ run: RUN, state: "ready", canDecide: true });
    vi.mocked(autopilotClient.carryOn).mockResolvedValue({
      ok: false,
      status: 409,
      message: "The run has ended.",
    } as never);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Let LUME AI carry on" }));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "warn", detail: "The run has ended." }),
    );
  });
});
