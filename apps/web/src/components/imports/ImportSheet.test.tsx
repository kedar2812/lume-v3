import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importsClient } from "@/lib/imports/client";
import { testDraft } from "@/lib/imports/test-draft";
import { ImportSheet } from "./ImportSheet";

vi.mock("@/lib/imports/client", () => ({
  importsClient: {
    upload: vi.fn(),
    draft: vi.fn(),
    patch: vi.fn(),
    preview: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
    seen: vi.fn(),
    discard: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
  },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const file = (text: string, name = "leads.csv") => new File([text], name, { type: "text/csv" });

beforeEach(() => vi.clearAllMocks());

describe("ImportSheet — File", () => {
  it("uploads a dropped file, shows how LUME read it, and moves on to Columns", async () => {
    vi.mocked(importsClient.upload).mockResolvedValue(ok(testDraft()));
    render(<ImportSheet open onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Import leads" });
    await userEvent.upload(within(dialog).getByLabelText(/Choose a CSV file/), file("Name\nA\n"));
    expect(importsClient.upload).toHaveBeenCalled();
    expect(await within(dialog).findByText("leads.csv · 3 rows")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Encoding: UTF-8/ })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByRole("heading", { name: "Match your columns" })).toBeInTheDocument();
  });

  it("says why a file can't be read, in LUME's words", async () => {
    vi.mocked(importsClient.upload).mockResolvedValue({
      ok: false,
      status: 400,
      code: "NOT_CSV_EXCEL",
      message: "This is an Excel file. Save it as CSV (File → Save as → CSV UTF-8) and upload that.",
    });
    render(<ImportSheet open onClose={vi.fn()} />);
    await userEvent.upload(screen.getByLabelText(/Choose a CSV file/), file("x", "leads.xlsx"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save it as CSV");
  });

  it("refuses a file over 10 MB before uploading it", async () => {
    render(<ImportSheet open onClose={vi.fn()} />);
    const big = new File([new Uint8Array(10_485_761)], "big.csv");
    await userEvent.upload(screen.getByLabelText(/Choose a CSV file/), big);
    expect(importsClient.upload).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("over 10 MB");
  });

  it("warns when the same file was imported before", async () => {
    vi.mocked(importsClient.upload).mockResolvedValue(
      ok(testDraft({ alreadyImported: { at: "2026-09-03T10:00:00Z", by: "Leila Haddad" } })),
    );
    render(<ImportSheet open onClose={vi.fn()} />);
    await userEvent.upload(screen.getByLabelText(/Choose a CSV file/), file("Name\nA\n"));
    expect(await screen.findByText(/already imported on 3 Sep by Leila Haddad/)).toBeInTheDocument();
  });

  it("changes the header row and re-reads the file", async () => {
    vi.mocked(importsClient.upload).mockResolvedValue(ok(testDraft()));
    vi.mocked(importsClient.patch).mockResolvedValue(ok(testDraft({ headerRow: 2 })));
    render(<ImportSheet open onClose={vi.fn()} />);
    await userEvent.upload(screen.getByLabelText(/Choose a CSV file/), file("x\nName\nA\n"));
    await userEvent.click(await screen.findByRole("button", { name: /Header: row 1/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Row 2" }));
    expect(importsClient.patch).toHaveBeenCalledWith(testDraft().id, { headerRow: 2 });
  });

  it("asks before closing a draft, and keeps it for later", async () => {
    vi.mocked(importsClient.upload).mockResolvedValue(ok(testDraft()));
    const onClose = vi.fn();
    render(<ImportSheet open onClose={onClose} />);
    await userEvent.upload(screen.getByLabelText(/Choose a CSV file/), file("Name\nA\n"));
    await screen.findByText("leads.csv · 3 rows");
    await userEvent.keyboard("{Escape}");
    const ask = screen.getByRole("alertdialog", { name: "Keep this import for later?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Keep for later" }));
    expect(importsClient.discard).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ImportSheet — opened again (bug hunt 2026-11-17)", () => {
  const done = (id: string, fileName: string) => ({
    id,
    status: "done",
    fileName,
    rowCount: 3,
    cursorRow: 4,
    counts: {
      created: 3,
      merged: 0,
      skipped: 0,
      empty: 0,
      errors: 0,
      warnings: 0,
      nameFromContact: 0,
      missingStageFields: 0,
      phoneNeedsCountry: 0,
    },
    startedBy: { id: "u-maya", name: "Maya Kapoor" },
    createdAt: "2026-09-27T09:00:00Z",
    startedAt: "2026-09-27T09:01:00Z",
    finishedAt: "2026-09-27T09:02:00Z",
    seenAt: null,
    stopReason: null,
    sourceId: "src1",
    canSeeRows: true,
    mine: true,
  });

  it("closed after an import's report, it opens again at the start, ready for the next file", async () => {
    vi.mocked(importsClient.get).mockResolvedValue(ok(done("i1", "first.csv")) as never);
    const { rerender } = render(<ImportSheet open importId="i1" onClose={vi.fn()} />);
    expect(await screen.findByText("first.csv is in LUME")).toBeInTheDocument();
    rerender(<ImportSheet open={false} importId="i1" onClose={vi.fn()} />);
    rerender(<ImportSheet open onClose={vi.fn()} />);
    expect(screen.getByLabelText(/Choose a CSV file/)).toBeInTheDocument();
    expect(screen.queryByText("first.csv is in LUME")).toBeNull();
  });

  it("one import's report, then another's: it shows the second", async () => {
    vi.mocked(importsClient.get).mockImplementation(
      async (id: string) => ok(id === "i1" ? done("i1", "first.csv") : done("i2", "second.csv")) as never,
    );
    const { rerender } = render(<ImportSheet open importId="i1" onClose={vi.fn()} />);
    expect(await screen.findByText("first.csv is in LUME")).toBeInTheDocument();
    rerender(<ImportSheet open={false} importId="i1" onClose={vi.fn()} />);
    rerender(<ImportSheet open importId="i2" onClose={vi.fn()} />);
    expect(await screen.findByText("second.csv is in LUME")).toBeInTheDocument();
    expect(screen.queryByText("first.csv is in LUME")).toBeNull();
  });
});
