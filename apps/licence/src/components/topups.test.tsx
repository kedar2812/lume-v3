// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client";
import { TopUps } from "./TopUps";

vi.mock("@/lib/client", () => ({
  CHANGED: "lume-licence:changed",
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));
beforeEach(() => vi.mocked(api.post).mockReset());

const REQUEST = {
  month: "2026-10",
  askedAt: "2026-10-20T10:00:00.000Z",
  askedBy: "Priya Shah",
  askedByEmail: "priya@harbour.example",
  note: "Running Autopilot on a campaign.",
};

describe("LUME AI top-ups on a client's page (Autopilot spec 2026-10-19 §4)", () => {
  it("shows what was asked, by whom, and adds a top-up for that month", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    vi.mocked(api.post).mockResolvedValue({
      ok: true,
      data: { topUps: { requests: [], added: [] } },
    } as never);
    render(
      <TopUps clientId="c1" monthly={3000} topUps={{ requests: [REQUEST], added: [] }} onSaved={onSaved} />,
    );
    const card = screen.getByRole("region", { name: "LUME AI top-ups" });
    expect(card).toHaveTextContent("Priya Shah asked for October 2026");
    expect(card).toHaveTextContent("Running Autopilot on a campaign.");
    await user.type(within(card).getByRole("spinbutton", { name: "AI calls to add" }), "1500");
    await user.click(within(card).getByRole("button", { name: "Add a top-up" }));
    expect(api.post).toHaveBeenCalledWith("/api/clients/c1/topup", {
      month: "2026-10",
      calls: 1500,
      note: "",
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("refuses an empty or a zero top-up before sending", async () => {
    const user = userEvent.setup();
    render(
      <TopUps clientId="c1" monthly={3000} topUps={{ requests: [REQUEST], added: [] }} onSaved={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Add a top-up" })).toBeDisabled();
    await user.type(screen.getByRole("spinbutton", { name: "AI calls to add" }), "0");
    expect(screen.getByRole("button", { name: "Add a top-up" })).toBeDisabled();
  });

  it("lists what was added before", () => {
    render(
      <TopUps
        clientId="c1"
        monthly={3000}
        topUps={{
          requests: [],
          added: [{ month: "2026-09", calls: 900, note: "Launch", addedAt: "2026-09-12T08:00:00.000Z" }],
        }}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole("region", { name: "LUME AI top-ups" })).toHaveTextContent(
      "900 calls for September 2026",
    );
  });
});
