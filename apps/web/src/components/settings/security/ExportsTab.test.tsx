import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { ExportRow, TraceMatch } from "@/lib/settings/security";
import { ExportsTab } from "./ExportsTab";

vi.mock("@/lib/api", () => ({ api: { post: vi.fn(), upload: vi.fn(), get: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const TZ = "Asia/Dubai";

const match = (foundBy: "column" | "check_row"): TraceMatch => ({
  id: "e-1",
  code: "PX7Q-4MRA",
  who: { id: "u-maya", name: "Maya Kapoor" },
  createdAt: "2026-10-01T12:12:00Z", // 4:12 pm in Dubai
  label: "Hot leads",
  rows: 128,
  format: "csv",
  foundBy,
  downloads: [{ at: "2026-10-01T12:13:00Z", device: "Chrome · Mac" }],
});
const rows: ExportRow[] = [
  {
    id: "e-1",
    code: "PX7Q-4MRA",
    label: "Hot leads",
    format: "csv",
    rows: 128,
    createdAt: "2026-10-01T12:12:00Z",
    expiresAt: "2026-10-02T12:12:00Z",
    available: true,
    downloads: 1,
    who: { id: "u-maya", name: "Maya Kapoor", initials: "MK" },
  },
  {
    id: "e-2",
    code: "H9TB-3QXE",
    label: "All leads",
    format: "xlsx",
    rows: 2406,
    createdAt: "2026-09-18T14:40:00Z",
    expiresAt: "2026-09-19T14:40:00Z",
    available: false,
    downloads: 2,
    who: { id: "u-hana", name: "Hana Ito", initials: "HI" },
  },
];
const file = (name = "leads-export.csv") => new File(["Name,Phone\nDana,1"], name, { type: "text/csv" });

beforeEach(() => vi.clearAllMocks());

describe("Security → Exports: Trace a file (6B Task 5)", () => {
  it("a file with its column: whose export, when, what, each download, and how it was found", async () => {
    vi.mocked(api.upload).mockResolvedValue(ok({ match: match("column") }));
    render(<ExportsTab initial={rows} timezone={TZ} viewerId="u-maya" />);
    await userEvent.upload(screen.getByLabelText("Choose a file"), file());
    expect(api.upload).toHaveBeenCalledWith("/api/v1/security/trace", expect.any(File));
    const found = await screen.findByRole("region", { name: "Maya Kapoor’s export" });
    expect(found).toHaveTextContent("Oct 1, Thu, 4:12 pm · code PX7Q-4MRA");
    expect(found).toHaveTextContent("Hot leads, 128 leads, as CSV");
    expect(found).toHaveTextContent("Once, at 4:13 pm, from Chrome · Mac");
    expect(found).toHaveTextContent("The LUME ref column");
    expect(within(found).getByRole("link", { name: "Open the audit log" })).toHaveAttribute(
      "href",
      "/settings/audit?actor=u-maya",
    );
  });

  it("a file with its column deleted: found by the check row, said so", async () => {
    vi.mocked(api.upload).mockResolvedValue(ok({ match: match("check_row") }));
    render(<ExportsTab initial={rows} timezone={TZ} viewerId="u-maya" />);
    fireEvent.drop(screen.getByTestId("trace-drop"), { dataTransfer: { files: [file()] } });
    expect(
      await screen.findByText("A hidden check row. Someone deleted the LUME ref column, but the row stayed."),
    ).toBeInTheDocument();
  });

  it("nothing matches: said plainly, never a guess; and Check another file starts again", async () => {
    vi.mocked(api.upload).mockResolvedValue(ok({ match: null }));
    render(<ExportsTab initial={rows} timezone={TZ} viewerId="u-maya" />);
    await userEvent.upload(screen.getByLabelText("Choose a file"), file());
    expect(await screen.findByText("No LUME export matches this file")).toBeInTheDocument();
    expect(
      screen.getByText("It may have been copied by hand, or come from somewhere else."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check another file" }));
    expect(await screen.findByText("Drop a CSV or Excel file here")).toBeInTheDocument();
  });

  it("a file LUME can't read says so in its words", async () => {
    vi.mocked(api.upload).mockResolvedValue({
      ok: false,
      status: 400,
      code: "UNREADABLE",
      message: "LUME can't read this file. Give it a CSV or Excel file.",
    });
    render(<ExportsTab initial={rows} timezone={TZ} viewerId="u-maya" />);
    await userEvent.upload(screen.getByLabelText("Choose a file"), file("report.pdf"));
    expect(await screen.findByRole("alert")).toHaveTextContent("LUME can't read this file.");
  });

  it("a code typed by hand is looked up", async () => {
    vi.mocked(api.post).mockResolvedValue(ok({ match: match("column") }));
    render(<ExportsTab initial={rows} timezone={TZ} viewerId="u-maya" />);
    await userEvent.type(screen.getByLabelText("Or type the code from its LUME ref column"), "px7q4mra");
    await userEvent.click(screen.getByRole("button", { name: "Look it up" }));
    expect(api.post).toHaveBeenCalledWith("/api/v1/security/trace", { code: "px7q4mra" });
    expect(await screen.findByRole("region", { name: "Maya Kapoor’s export" })).toBeInTheDocument();
  });

  it("says how the mark works, exactly", () => {
    render(<ExportsTab initial={rows} timezone={TZ} viewerId="u-maya" />);
    expect(
      screen.getByText(/Each export has a code on every row, and one made-up lead only LUME recognises\./),
    ).toBeInTheDocument();
  });
});

describe("Security → Exports: the list (6B Task 5)", () => {
  it("each export: what, who and when, the code, and the time left or Expired", () => {
    render(
      <ExportsTab initial={rows} timezone={TZ} viewerId="u-maya" now={new Date("2026-10-01T13:12:00Z")} />,
    );
    const list = screen.getByRole("list", { name: "Exports" });
    const [live, gone] = within(list).getAllByRole("listitem");
    expect(live).toHaveTextContent("Hot leads · 128 leads · CSV");
    expect(live).toHaveTextContent("PX7Q-4MRA");
    expect(live).toHaveTextContent("23 h left");
    expect(within(live!).getByRole("link", { name: "Download Hot leads" })).toHaveAttribute(
      "href",
      "/api/v1/leads/exports/e-1/download",
    );
    expect(gone).toHaveTextContent("All leads · 2,406 leads · Excel");
    expect(gone).toHaveTextContent("Expired");
    expect(within(gone!).queryByRole("link", { name: /Download/ })).not.toBeInTheDocument();
  });

  it("someone else's live export can't be downloaded here", async () => {
    render(
      <ExportsTab initial={rows} timezone={TZ} viewerId="u-hana" now={new Date("2026-10-01T13:12:00Z")} />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Download Hot leads" })).not.toBeInTheDocument(),
    );
  });
});
