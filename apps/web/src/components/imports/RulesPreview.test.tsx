import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importsClient } from "@/lib/imports/client";
import { testDraft } from "@/lib/imports/test-draft";
import { PreviewStep } from "./PreviewStep";
import { RulesStep } from "./RulesStep";

vi.mock("@/lib/imports/client", () => ({
  importsClient: { patch: vi.fn(), preview: vi.fn(), start: vi.fn() },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
beforeEach(() => vi.clearAllMocks());

describe("RulesStep", () => {
  it("defaults to Merge, recommended, and explains each choice in a line", () => {
    render(<RulesStep draft={testDraft()} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    const group = screen.getByRole("radiogroup", { name: "When a row matches an existing lead" });
    expect(within(group).getByRole("radio", { name: /Merge/ })).toBeChecked();
    expect(within(group).getByText(/fills only empty fields/)).toBeInTheDocument();
  });

  it("offers giving leads to others only with Assign, and saves the owner rule", async () => {
    vi.mocked(importsClient.patch).mockResolvedValue(ok(testDraft()));
    render(<RulesStep draft={testDraft()} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    await userEvent.click(screen.getByRole("radio", { name: "Take turns" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Riya Sharma" }));
    expect(
      (vi.mocked(importsClient.patch).mock.calls.at(-1)![1] as { rules: { owner: unknown } }).rules.owner,
    ).toEqual({ mode: "round_robin", userIds: ["u-riya"] });
    render(
      <RulesStep
        draft={testDraft({ can: { assign: false, manageFields: true, manageTags: true } })}
        onDraft={vi.fn()}
        onContinue={vi.fn()}
        blocked={false}
      />,
    );
    expect(screen.getAllByRole("radio", { name: "Take turns" })[1]).toBeDisabled();
  });

  it("asks for a default for each required field without a column", async () => {
    const draft = testDraft({
      problems: [
        {
          column: null,
          code: "REQUIRED_FIELD_UNCOVERED",
          field: "tier",
          message: "Tier is needed on every lead: map a column to it or choose a default.",
        },
      ],
    });
    render(<RulesStep draft={draft} onDraft={vi.fn()} onContinue={vi.fn()} blocked />);
    expect(screen.getByRole("combobox", { name: "Tier for every imported lead" })).toBeInTheDocument();
  });
});

describe("PreviewStep", () => {
  it("shows what each row will do, in words, with a summary", async () => {
    vi.mocked(importsClient.preview).mockResolvedValue(
      ok({
        rows: [
          {
            rowNumber: 2,
            outcome: "create",
            name: "Aisha Khan",
            mergeInto: null,
            alsoMatches: 0,
            problems: [],
            warnings: [],
          },
          {
            rowNumber: 3,
            outcome: "merge",
            name: "Omar",
            mergeInto: { visible: true, leadId: "l1", name: "Omar Haddad", ownerName: "Riya Sharma" },
            alsoMatches: 0,
            problems: [],
            warnings: [],
          },
          {
            rowNumber: 4,
            outcome: "merge",
            name: "X",
            mergeInto: { visible: false },
            alsoMatches: 0,
            problems: [],
            warnings: [],
          },
          {
            rowNumber: 5,
            outcome: "error",
            name: null,
            mergeInto: null,
            alsoMatches: 0,
            problems: [
              { column: 2, code: "STAGE_UNKNOWN", message: "No stage called “Hot” in this pipeline." },
            ],
            warnings: [],
          },
        ],
        summary: { create: 1, merge: 2, skip: 0, error: 1, empty: 0 },
        scanned: 4,
      }),
    );
    render(<PreviewStep draft={testDraft()} onFix={vi.fn()} onStarted={vi.fn()} />);
    expect(await screen.findByText("1 create · 2 merge · 1 error")).toBeInTheDocument();
    expect(screen.getByText("Merges into Omar Haddad (Riya Sharma)")).toBeInTheDocument();
    expect(screen.getByText("Merges into an existing lead")).toBeInTheDocument();
    expect(screen.getByText("No stage called “Hot” in this pipeline.")).toBeInTheDocument();
  });

  it("starts the import, and a second press does nothing", async () => {
    vi.mocked(importsClient.preview).mockResolvedValue(
      ok({ rows: [], summary: { create: 0, merge: 0, skip: 0, error: 0, empty: 0 }, scanned: 0 }),
    );
    vi.mocked(importsClient.start).mockResolvedValue(ok({ id: "i1", status: "queued" } as never));
    const onStarted = vi.fn();
    render(<PreviewStep draft={testDraft()} onFix={vi.fn()} onStarted={onStarted} />);
    const go = await screen.findByRole("button", { name: "Import 3 rows" });
    await userEvent.dblClick(go);
    expect(importsClient.start).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalled();
  });

  it("shows why Start was refused, and where to fix it", async () => {
    vi.mocked(importsClient.preview).mockResolvedValue(
      ok({ rows: [], summary: { create: 0, merge: 0, skip: 0, error: 0, empty: 0 }, scanned: 0 }),
    );
    vi.mocked(importsClient.start).mockResolvedValue({
      ok: false,
      status: 400,
      code: "MAPPING_INVALID",
      message: "That field no longer exists.",
    });
    const onFix = vi.fn();
    render(<PreviewStep draft={testDraft()} onFix={onFix} onStarted={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Import 3 rows" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That field no longer exists.");
    await userEvent.click(screen.getByRole("button", { name: "Back to Columns" }));
    expect(onFix).toHaveBeenCalledWith("columns");
  });

  it("checks the whole file for problems on request, and goes back to the first rows", async () => {
    const problem = { column: 2, code: "STAGE_UNKNOWN", message: "No stage called “Hot” in this pipeline." };
    vi.mocked(importsClient.preview)
      .mockResolvedValueOnce(
        ok({ rows: [], summary: { create: 3, merge: 0, skip: 0, error: 0, empty: 0 }, scanned: 3 }),
      )
      .mockResolvedValueOnce(
        ok({
          rows: [
            {
              rowNumber: 812,
              outcome: "error" as const,
              name: null,
              mergeInto: null,
              alsoMatches: 0,
              problems: [problem],
              warnings: [],
            },
          ],
          summary: { create: 0, merge: 0, skip: 0, error: 1, empty: 0 },
          scanned: 1200,
        }),
      );
    render(<PreviewStep draft={testDraft()} onFix={vi.fn()} onStarted={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Show rows with problems" }));
    expect(importsClient.preview).toHaveBeenLastCalledWith(testDraft().id, { errorsOnly: true });
    expect(await screen.findByText("LUME checked all 1,200 rows: 1 has problems.")).toBeInTheDocument();
    expect(screen.getByText("812")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to the first rows" })).toBeInTheDocument();
  });
});
