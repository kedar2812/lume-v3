import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importsClient } from "@/lib/imports/client";
import { testDraft } from "@/lib/imports/test-draft";
import { ColumnsStep } from "./ColumnsStep";

vi.mock("@/lib/imports/client", () => ({ importsClient: { patch: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
beforeEach(() => vi.clearAllMocks());

describe("ColumnsStep", () => {
  it("shows each column with sample values and where it goes", () => {
    render(<ColumnsStep draft={testDraft()} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    const row = screen.getByRole("row", { name: /Mobile/ });
    expect(within(row).getByText("050 123 4567")).toBeInTheDocument();
    expect(within(row).getByRole("combobox", { name: "Mobile goes to" })).toHaveValue("phone");
  });

  it("sends the whole mapping when a column changes", async () => {
    vi.mocked(importsClient.patch).mockResolvedValue(ok(testDraft()));
    render(<ColumnsStep draft={testDraft()} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Email goes to" }), "ignore");
    const sent = vi.mocked(importsClient.patch).mock.calls[0]![1] as {
      mapping: { columns: { to: string }[] };
    };
    expect(sent.mapping.columns.map((c) => c.to)).toEqual(["field", "field", "ignore"]);
  });

  it("makes a new field from a column, only for someone who can", async () => {
    vi.mocked(importsClient.patch).mockResolvedValue(ok(testDraft()));
    render(<ColumnsStep draft={testDraft()} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Email goes to" }), "new_field");
    expect(screen.getByRole("textbox", { name: "New field's name" })).toHaveValue("Email");
    const { unmount } = render(
      <ColumnsStep
        draft={testDraft({ can: { assign: true, manageFields: false, manageTags: true } })}
        onDraft={vi.fn()}
        onContinue={vi.fn()}
        blocked={false}
      />,
    );
    expect(
      within(screen.getAllByRole("combobox", { name: "Email goes to" })[1]!).queryByRole("option", {
        name: "New field…",
      }),
    ).toBeNull();
    unmount();
  });

  it("lists unmatched values with their counts, and maps, adds or empties each", async () => {
    const draft = testDraft({
      mapping: {
        columns: [
          { column: 0, to: "field", field: "name" },
          { column: 1, to: "field", field: "tier" },
        ],
        createMissingTags: false,
      },
      analysis: [
        { column: 0, unmatched: [] },
        {
          column: 1,
          unmatched: [
            { value: "Platinum", rows: 12 },
            { value: "Silver+", rows: 2 },
          ],
        },
      ],
      problems: [],
    });
    vi.mocked(importsClient.patch).mockResolvedValue(ok(draft));
    render(<ColumnsStep draft={draft} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    const panel = screen.getByRole("region", { name: "Values LUME doesn't recognise" });
    expect(within(panel).getByText("Platinum")).toBeInTheDocument();
    expect(within(panel).getByText("12 rows")).toBeInTheDocument();
    await userEvent.selectOptions(within(panel).getByRole("combobox", { name: "Platinum becomes" }), "add");
    expect(
      (
        vi.mocked(importsClient.patch).mock.calls.at(-1)![1] as {
          mapping: { addOptions: Record<string, string[]> };
        }
      ).mapping.addOptions,
    ).toEqual({ tier: ["Platinum"] });
    await userEvent.selectOptions(
      within(panel).getByRole("combobox", { name: "Silver+ becomes" }),
      "o-silver",
    );
    const last = vi.mocked(importsClient.patch).mock.calls.at(-1)![1] as {
      mapping: { columns: { transform?: { valueMap?: Record<string, string | null> } }[] };
    };
    expect(last.mapping.columns[1]!.transform?.valueMap).toEqual({ "Silver+": "Silver" });
  });

  it("asks how to read an ambiguous date column, and locks Continue until it's answered", async () => {
    const draft = testDraft({
      headers: ["Name", "Date"],
      sample: [
        ["A", "13/03/2026"],
        ["B", "03/13/2026"],
      ],
      mapping: {
        columns: [
          { column: 0, to: "field", field: "name" },
          { column: 1, to: "field", field: "lead_created_at" },
        ],
        createMissingTags: false,
      },
      analysis: [
        { column: 0, unmatched: [] },
        { column: 1, dateOrder: "conflict", unmatched: [] },
      ],
      problems: [
        {
          column: 1,
          code: "DATE_ORDER_NEEDED",
          message: "This column has dates like 13/03 and 03/13 — choose how to read them.",
        },
      ],
    });
    render(<ColumnsStep draft={draft} onDraft={vi.fn()} onContinue={vi.fn()} blocked />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByText(/choose how to read them/)).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Read dates in Date as" })).toBeInTheDocument();
  });

  it("names every field that's needed on every lead and has no column", () => {
    const draft = testDraft({
      problems: [
        {
          column: null,
          code: "REQUIRED_FIELD_UNCOVERED",
          message: "Tier is needed on every lead: map a column to it or choose a default.",
        },
      ],
    });
    render(<ColumnsStep draft={draft} onDraft={vi.fn()} onContinue={vi.fn()} blocked />);
    expect(screen.getByText(/Tier is needed on every lead/)).toBeInTheDocument();
  });
});
