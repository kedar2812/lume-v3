import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { aboutClient } from "@/lib/settings/about";
import { About } from "./About";

vi.mock("@/lib/settings/about", () => ({ aboutClient: { get: vi.fn() } }));

describe("About", () => {
  it("shows the version and the last restore test in plain words", async () => {
    vi.mocked(aboutClient.get)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          version: "1.3.0",
          lastRestoreTest: {
            finishedAt: "2026-09-22T04:00:00Z",
            ok: true,
            backup: "lume-20260922T0200Z.dump.age",
          },
        },
      })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { version: "1.3.0", lastRestoreTest: null } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          version: "1.3.0",
          lastRestoreTest: { finishedAt: "2026-09-22T04:00:00Z", ok: false, backup: null },
        },
      });
    const first = render(<About />);
    expect(await screen.findByText("Last restore test: passed, 22 Sep 2026")).toBeInTheDocument();
    expect(screen.getByText("Version 1.3.0")).toBeInTheDocument();
    first.unmount();
    const second = render(<About />);
    expect(await screen.findByText("No restore test has run yet")).toBeInTheDocument();
    second.unmount();
    render(<About />);
    expect(await screen.findByText("Last restore test: failed, 22 Sep 2026")).toBeInTheDocument();
  });
});
