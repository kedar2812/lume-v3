import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { ExportSheet } from "./ExportSheet";

vi.mock("@/lib/api", () => ({ api: { post: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 201, data });
const props = {
  label: "Hot leads",
  count: 128,
  columns: ["name", "stage", "phone"],
  filters: { sort: "newest", stageId: "s-1" },
  onClose: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

describe("Export on the Leads list (6B Task 5)", () => {
  it("says what it will export, and the promise, in one line each", () => {
    render(<ExportSheet {...props} />);
    const sheet = screen.getByRole("dialog", { name: "Export Hot leads" });
    expect(sheet).toHaveTextContent("128 leads · 3 columns");
    expect(sheet).toHaveTextContent(
      "Each file carries a mark that traces it back to you. It’s deleted after 24 hours.",
    );
    expect(screen.getByRole("radio", { name: /^CSV/ })).toBeChecked();
  });

  it("makes the file from the view, then offers it to download", async () => {
    vi.mocked(api.post).mockResolvedValue(
      ok({
        export: {
          id: "e-9",
          code: "PX7Q-4MRA",
          rows: 128,
          format: "xlsx",
          label: "Hot leads",
          available: true,
        },
      }),
    );
    render(<ExportSheet {...props} />);
    await userEvent.click(screen.getByRole("radio", { name: /^Excel/ }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(api.post).toHaveBeenCalledWith("/api/v1/leads/export", {
      format: "xlsx",
      label: "Hot leads",
      filters: { sort: "newest", stageId: "s-1" },
      columns: ["name", "stage", "phone"],
    });
    const link = await screen.findByRole("link", { name: "Download" });
    expect(link).toHaveAttribute("href", "/api/v1/leads/exports/e-9/download");
    expect(screen.getByText(/code PX7Q-4MRA/)).toBeInTheDocument();
  });

  it("says why it can't, in LUME's words", async () => {
    vi.mocked(api.post).mockResolvedValue({
      ok: false,
      status: 422,
      code: "TOO_MANY",
      message: "Narrow the view: up to 25,000 leads in one file.",
    });
    render(<ExportSheet {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Narrow the view: up to 25,000 leads in one file.",
    );
  });
});
