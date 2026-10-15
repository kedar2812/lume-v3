import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { licenceLine, OnlineMoment } from "./OnlineMoment";

const play = vi.fn();
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play }) }));

const LICENCE = { licenseType: "subscription" as const, paidUntil: "2026-11-15", trialEndsAt: null };
afterEach(() => {
  play.mockClear();
  vi.useRealTimers();
});

describe("your LUME is online (spec 2026-10-15 §1.1)", () => {
  it("says so, with the licence, and Proceed to onboarding goes on", async () => {
    const onProceed = vi.fn();
    render(<OnlineMoment licence={LICENCE} reduce={false} onProceed={onProceed} />);
    expect(screen.getByRole("status")).toHaveTextContent("Congratulations — your LUME is online");
    expect(screen.getByRole("status")).toHaveTextContent("Subscription · paid until November 15, 2026");
    await userEvent.click(screen.getByRole("button", { name: "Proceed to onboarding" }));
    expect(onProceed).toHaveBeenCalledOnce();
  });

  it("the online chime plays once, as the ring closes (1.82 s in)", () => {
    vi.useFakeTimers();
    render(<OnlineMoment licence={LICENCE} reduce={false} onProceed={() => undefined} />);
    act(() => vi.advanceTimersByTime(1800));
    expect(play).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(40));
    expect(play).toHaveBeenCalledExactlyOnceWith("online");
  });

  it("with reduced motion it plays at once", () => {
    vi.useFakeTimers();
    render(<OnlineMoment licence={LICENCE} reduce onProceed={() => undefined} />);
    act(() => vi.advanceTimersByTime(130));
    expect(play).toHaveBeenCalledExactlyOnceWith("online");
  });

  it("says each kind of licence in plain words", () => {
    expect(licenceLine(LICENCE)).toBe("Subscription · paid until November 15, 2026");
    expect(licenceLine({ licenseType: "perpetual", paidUntil: null, trialEndsAt: null })).toBe(
      "Perpetual licence · never expires",
    );
    expect(licenceLine({ licenseType: "trial", paidUntil: null, trialEndsAt: "2026-10-29" })).toBe(
      "Trial · until October 29, 2026",
    );
  });
});
