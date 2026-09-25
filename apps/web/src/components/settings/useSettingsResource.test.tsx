import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingsResource } from "./useSettingsResource";

describe("useSettingsResource", () => {
  it("loads, and turns a 403 mid-visit into a calm 'access changed' state", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, data: { name: "LUME" } })
      .mockResolvedValueOnce({ ok: false, status: 403, code: "FORBIDDEN", message: "no" });
    const { result } = renderHook(() => useSettingsResource(load));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.data).toEqual({ name: "LUME" });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state).toBe("access-changed"));
  });

  it("lets a save report a refusal the same way", async () => {
    const load = vi.fn().mockResolvedValue({ ok: true, status: 200, data: 1 });
    const { result } = renderHook(() => useSettingsResource(load));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    let ok = true;
    act(() => {
      ok = result.current.guard({ ok: false, status: 403, code: "FORBIDDEN", message: "no" });
    });
    expect(ok).toBe(false);
    expect(result.current.state).toBe("access-changed");
  });

  it("says a load failed without claiming access changed", async () => {
    const load = vi.fn().mockResolvedValue({ ok: false, status: 0, code: "OFFLINE", message: "offline" });
    const { result } = renderHook(() => useSettingsResource(load));
    await waitFor(() => expect(result.current.state).toBe("error"));
  });

  it("starts from data the server already sent, without loading it again", async () => {
    const load = vi.fn();
    const { result } = renderHook(() => useSettingsResource(load, { initial: { name: "LUME" } }));
    expect(result.current.state).toBe("ready");
    expect(result.current.data).toEqual({ name: "LUME" });
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps the page for a refusal that isn't about access (a 403 with its own reason)", async () => {
    const load = vi.fn().mockResolvedValue({ ok: true, status: 200, data: 1 });
    const { result } = renderHook(() => useSettingsResource(load));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    act(() => {
      result.current.guard({ ok: false, status: 403, code: "ESCALATION", message: "no" });
    });
    expect(result.current.state).toBe("ready");
  });
});
