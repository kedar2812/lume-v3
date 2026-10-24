import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiClient } from "./client";
import { forgetAiOn, useAiOn } from "./use-ai-on";

vi.mock("./client", () => ({ aiClient: { status: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.resetAllMocks();
  forgetAiOn();
});

/** Whether LUME AI is on for this person (Autopilot A3: the island's "Let LUME AI handle these"). */
describe("useAiOn", () => {
  it("asks once for the page, however many places want to know", async () => {
    vi.mocked(aiClient.status).mockResolvedValue(ok({ on: true } as never));
    const a = renderHook(() => useAiOn());
    const b = renderHook(() => useAiOn());
    await waitFor(() => expect(a.result.current).toBe(true));
    await waitFor(() => expect(b.result.current).toBe(true));
    expect(aiClient.status).toHaveBeenCalledTimes(1);
  });

  it("off, or not known (a failed read), is off", async () => {
    vi.mocked(aiClient.status).mockResolvedValue({ ok: false, status: 0, code: "OFFLINE", message: "x" });
    const { result } = renderHook(() => useAiOn());
    await waitFor(() => expect(aiClient.status).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("a failed read is asked again next time, not remembered", async () => {
    vi.mocked(aiClient.status).mockResolvedValueOnce({ ok: false, status: 0, code: "OFFLINE", message: "x" });
    const first = renderHook(() => useAiOn());
    await waitFor(() => expect(aiClient.status).toHaveBeenCalledTimes(1));
    first.unmount();
    vi.mocked(aiClient.status).mockResolvedValueOnce(ok({ on: true } as never));
    const again = renderHook(() => useAiOn());
    await waitFor(() => expect(again.result.current).toBe(true));
  });
});
