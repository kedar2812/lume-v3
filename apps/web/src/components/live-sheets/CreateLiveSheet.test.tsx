import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCatalog } from "@/lib/leads/test-catalog";
import { liveSheetsClient, type LiveSheetView } from "@/lib/live-sheets/client";
import type { LiveSheetEvent } from "@/lib/notifications/stream";
import { CreateLiveSheet } from "./CreateLiveSheet";

let streamed: ((e: LiveSheetEvent) => void) | null = null;
vi.mock("@/lib/notifications/stream", () => ({
  useLiveSheets: (on: (e: LiveSheetEvent) => void) => {
    streamed = on;
  },
}));
vi.mock("@/lib/live-sheets/client", async (orig) => {
  const real = await orig<typeof import("@/lib/live-sheets/client")>();
  return {
    ...real,
    liveSheetsClient: {
      count: vi.fn(),
      grants: vi.fn(),
      create: vi.fn(),
      edit: vi.fn(),
      get: vi.fn(),
      connectStart: vi.fn(),
    },
  };
});

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const view = (over: Partial<LiveSheetView> = {}): LiveSheetView => ({
  id: "s1",
  name: "Call booked leads",
  preset: "meta",
  rule: {
    stages: { mode: "reached", stageIds: ["s-booked"] },
    includeMissing: true,
    includeDnc: false,
    backfill: true,
  },
  ruleWords: "Leads that reached Call booked",
  columns: [],
  edits: "keep",
  status: "making",
  pauseReason: null,
  lastError: null,
  url: null,
  leadCount: 0,
  capped: false,
  lastSyncedAt: null,
  run: { total: 0, written: 0, status: "queued" },
  madeBy: { id: "u1", name: "Maya" },
  canChange: true,
  runsAs: { id: "u1", name: "Maya" },
  createdAt: "2026-11-14T09:00:00Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  streamed = null;
  vi.mocked(liveSheetsClient.count).mockResolvedValue(ok({ matching: 1284, missingContact: 40 }) as never);
  vi.mocked(liveSheetsClient.grants).mockResolvedValue(
    ok({ grants: [{ id: "g1", email: "maya@business.test" }] }) as never,
  );
});

const open = (o: Partial<Parameters<typeof CreateLiveSheet>[0]> = {}) => {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <CreateLiveSheet catalog={testCatalog()} contactsVisible onClose={onClose} onSaved={onSaved} {...o} />,
  );
  return { onClose, onSaved, dialog: () => screen.getByRole("dialog", { name: /live sheet/i }) };
};
const next = () => userEvent.click(screen.getByRole("button", { name: "Next" }));

describe("CreateLiveSheet", () => {
  it("For a Meta audience: Meta's own columns, read only, and a word on consent", async () => {
    open({ prefill: { stageIds: ["s-booked"] } });
    expect(screen.getByText("Step 1 of 4")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /For a Meta audience/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByText("Upload only people who agreed to hear from you. Meta's terms ask for it."),
    ).toBeInTheDocument();
    await next();
    await next();
    for (const c of ["email", "phone", "fn", "ln", "country"])
      expect(screen.getByText(c)).toBeInTheDocument();
  });

  it("Which leads: a prefilled stage is chosen, missing details included by default, the count said", async () => {
    open({ prefill: { stageIds: ["s-booked"] } });
    await next();
    expect(screen.getByRole("button", { name: "Call booked" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("switch", { name: "Include leads with no phone or email" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(await screen.findByText("1,284")).toBeInTheDocument();
    expect(screen.getByText(/40 have no phone or email/)).toBeInTheDocument();
    // No stage: nothing to go on with.
    await userEvent.click(screen.getByRole("button", { name: "Call booked" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("My own columns: only fields the person may see; a masked role gets no contact column", async () => {
    render(
      <CreateLiveSheet
        catalog={testCatalog()}
        contactsVisible={false}
        prefill={{ stageIds: ["s-new"] }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: /My own columns/ }));
    await next();
    await next();
    const list = screen.getByRole("list", { name: "Columns" });
    expect(within(list).queryByText("Email")).toBeNull();
    expect(within(list).queryByText("Phone")).toBeNull();
    expect(within(list).getByText("Name")).toBeInTheDocument();
    expect(within(list).getByText("Struggles")).toBeInTheDocument();
  });

  it("Make sends exactly what was chosen, then follows the progress to the link", async () => {
    vi.mocked(liveSheetsClient.create).mockResolvedValue(ok({ sheet: view() }) as never);
    const { onSaved } = open({ prefill: { stageIds: ["s-booked"] } });
    await next();
    await next();
    await next();
    await userEvent.clear(screen.getByLabelText("Sheet name"));
    await userEvent.type(screen.getByLabelText("Sheet name"), "Booked calls");
    await userEvent.click(screen.getByRole("radio", { name: /Put LUME's back/ }));
    await userEvent.click(screen.getByRole("button", { name: "Make the live sheet" }));
    expect(liveSheetsClient.create).toHaveBeenCalledWith({
      name: "Booked calls",
      preset: "meta",
      rule: {
        stages: { mode: "reached", stageIds: ["s-booked"] },
        includeMissing: true,
        includeDnc: false,
        backfill: true,
      },
      columns: [],
      edits: "replace",
      grantId: "g1",
    });
    expect(await screen.findByText("Making your sheet in Google")).toBeInTheDocument();
    vi.mocked(liveSheetsClient.get).mockResolvedValue(
      ok({
        sheet: view({
          status: "live",
          run: null,
          leadCount: 3,
          url: "https://docs.google.com/spreadsheets/d/x/edit",
        }),
      }) as never,
    );
    await act(async () => streamed?.({ sheet: "s1", kind: "status" }));
    expect(await screen.findByText("Live · 3 leads")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onSaved).toHaveBeenCalled();
  });

  it("no Google account yet: Connect Google first", async () => {
    vi.mocked(liveSheetsClient.grants).mockResolvedValue(ok({ grants: [] }) as never);
    open({ prefill: { stageIds: ["s-booked"] } });
    await next();
    await next();
    await next();
    expect(await screen.findByRole("button", { name: "Connect Google" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make the live sheet" })).toBeDisabled();
  });

  it("Edit opens with the sheet's choices and saves only them", async () => {
    vi.mocked(liveSheetsClient.edit).mockResolvedValue(ok({ sheet: view({ name: "Renamed" }) }) as never);
    const { onSaved } = open({ editing: view({ status: "live", run: null }) });
    expect(screen.getByRole("dialog", { name: "Edit live sheet" })).toBeInTheDocument();
    await next();
    expect(screen.getByRole("button", { name: "Call booked" })).toHaveAttribute("aria-pressed", "true");
    await next();
    await next();
    const name = screen.getByLabelText("Sheet name");
    await userEvent.clear(name);
    await userEvent.type(name, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(liveSheetsClient.edit).toHaveBeenCalledWith("s1", {
        name: "Renamed",
        preset: "meta",
        rule: view().rule,
        columns: [],
        edits: "keep",
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("Back goes to the step before, keeping what was chosen", async () => {
    open({ prefill: { stageIds: ["s-booked"] } });
    await next();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Step 1 of 4")).toBeInTheDocument();
    await next();
    expect(screen.getByRole("button", { name: "Call booked" })).toHaveAttribute("aria-pressed", "true");
  });
});
