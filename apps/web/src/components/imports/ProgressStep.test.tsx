import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importsClient } from "@/lib/imports/client";
import type { ImportView } from "@/lib/imports/types";
import { ProgressStep } from "./ProgressStep";

vi.mock("@/lib/imports/client", () => ({
  importsClient: { get: vi.fn(), cancel: vi.fn(), resume: vi.fn(), seen: vi.fn() },
}));
const view = (over: Partial<ImportView> = {}): ImportView => ({
  id: "i1",
  status: "running",
  fileName: "leads.csv",
  rowCount: 1000,
  cursorRow: 401,
  counts: {
    created: 380,
    merged: 15,
    skipped: 0,
    empty: 2,
    errors: 3,
    warnings: 10,
    nameFromContact: 4,
    missingStageFields: 0,
    phoneNeedsCountry: 6,
  },
  startedBy: { id: "u-maya", name: "Maya Kapoor" },
  createdAt: "2026-09-27T09:00:00Z",
  startedAt: "2026-09-27T09:01:00Z",
  finishedAt: null,
  seenAt: null,
  stopReason: null,
  sourceId: "src1",
  canSeeRows: true,
  mine: true,
  ...over,
});
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe("ProgressStep", () => {
  it("shows live counts, tells the importer LUME will let them know, and polls until done", async () => {
    vi.mocked(importsClient.get)
      .mockResolvedValueOnce(ok(view()))
      .mockResolvedValueOnce(
        ok(
          view({
            status: "done",
            cursorRow: 1001,
            counts: { ...view().counts, created: 970 },
            finishedAt: "2026-09-27T09:03:00Z",
          }),
        ),
      );
    render(<ProgressStep initial={view() as never} onClose={vi.fn()} />);
    expect(
      screen.getByText("You can close this — LUME will let you know when it's done."),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Rows done" })).toHaveAttribute("aria-valuenow", "400");
    await act(async () => vi.advanceTimersByTimeAsync(4100));
    expect(await screen.findByRole("heading", { name: "leads.csv is in LUME" })).toBeInTheDocument();
    expect(screen.getByText("970 created")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download the 3 rows with problems" })).toHaveAttribute(
      "href",
      "/api/v1/imports/i1/errors.csv",
    );
    expect(screen.getByRole("link", { name: "View imported leads" })).toHaveAttribute(
      "href",
      "/leads?source=src1",
    );
    expect(importsClient.seen).toHaveBeenCalledWith("i1");
  });

  it("cancels, and offers to import the rest", async () => {
    vi.mocked(importsClient.cancel).mockResolvedValue(ok(view({ status: "cancelling" })));
    vi.mocked(importsClient.get).mockResolvedValue(
      ok(view({ status: "cancelled", stopReason: "cancelled" })),
    );
    render(<ProgressStep initial={view() as never} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    await act(async () => vi.advanceTimersByTimeAsync(2100));
    expect(await screen.findByText(/Cancelled after row 400/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import the rest" })).toBeInTheDocument();
  });

  it("explains an import stopped because access changed", async () => {
    render(
      <ProgressStep
        initial={view({ status: "stopped_access", stopReason: "access_changed" }) as never}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "LUME stopped this import because your access changed",
    );
  });

  it("doesn't claim a file is in LUME when nothing was added", () => {
    const counts = { ...view().counts, created: 0, merged: 0, errors: 2 };
    render(
      <ProgressStep
        initial={view({ status: "done", counts, seenAt: "2026-09-27T09:05:00Z" })}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "leads.csv was checked — nothing was added" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View imported leads" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download the 2 rows with problems" })).toBeInTheDocument();
  });

  it("says where leads with their own enquiry dates count, so New today isn't a surprise", () => {
    render(
      <ProgressStep
        initial={view({
          status: "done",
          seenAt: "2026-09-27T09:05:00Z",
          dated: { n: 120, from: "2024-06-10", to: "2026-09-26" },
        })}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "120 came with their own enquiry dates, June 10, 2024 – September 26, 2026. They count on those days in Analytics and in “New today”, not as new today.",
      ),
    ).toBeInTheDocument();
  });
});
