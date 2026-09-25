import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { testCatalog, testLead } from "@/lib/leads/test-catalog";
import type { Lead } from "@/lib/leads/types";
import { CatalogProvider } from "./CatalogProvider";
import { useStageMove } from "./useStageMove";

vi.mock("@/lib/leads/client", () => ({ leadsClient: { move: vi.fn(), patch: vi.fn() } }));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
const cat = testCatalog();
const stage = (id: string) => cat.pipelines[0]!.stages.find((s) => s.id === id)!;

function Harness({ target, onResult }: { target: string; onResult: (l: Lead | null) => void }) {
  const { request, ui } = useStageMove();
  return (
    <>
      <button onClick={async () => onResult(await request(testLead(), stage(target)))}>go</button>
      {ui}
    </>
  );
}
const run = (target: string) => {
  const onResult = vi.fn();
  render(
    <CatalogProvider catalog={cat}>
      <Harness target={target} onResult={onResult} />
    </CatalogProvider>,
  );
  return onResult;
};

beforeEach(() => {
  vi.mocked(leadsClient.move).mockReset();
  vi.mocked(leadsClient.patch).mockReset();
  toast.mockReset();
});

describe("useStageMove", () => {
  it("moves straight away when nothing is needed", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({
      ok: true,
      status: 200,
      data: { lead: testLead({ stageId: "s-sent" }) },
    });
    const onResult = run("s-sent");
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ stageId: "s-sent" })),
    );
    expect(leadsClient.move).toHaveBeenCalledWith("l1", "s-sent", {});
  });

  it("asks why before moving to Lost, and cancelling changes nothing", async () => {
    const onResult = run("s-lost");
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByRole("dialog", { name: /why was aisha lost/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark as lost" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onResult).toHaveBeenCalledWith(null);
    expect(leadsClient.move).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sends the chosen reason and note", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({
      ok: true,
      status: 200,
      data: { lead: testLead({ stageId: "s-lost" }) },
    });
    const onResult = run("s-lost");
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await userEvent.click(await screen.findByRole("radio", { name: "Price" }));
    await userEvent.type(screen.getByLabelText("Note (optional)"), "Budget next quarter");
    await userEvent.click(screen.getByRole("button", { name: "Mark as lost" }));
    expect(leadsClient.move).toHaveBeenCalledWith("l1", "s-lost", {
      lostReasonId: "r-price",
      lostNote: "Budget next quarter",
    });
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ stageId: "s-lost" })),
    );
  });

  it("asks for missing required fields, saves them, then moves", async () => {
    vi.mocked(leadsClient.move)
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        code: "REQUIRED_FIELDS",
        message: "Fill these in",
        details: { fields: ["struggles"] },
      })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { lead: testLead({ stageId: "s-booked" }) } });
    vi.mocked(leadsClient.patch).mockResolvedValue({
      ok: true,
      status: 200,
      data: { lead: testLead({ version: 2, custom: { struggles: ["o1"] } }) },
    });
    const onResult = run("s-booked");
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    const dialog = await screen.findByRole("dialog", { name: /before moving to call booked/i });
    await userEvent.click(screen.getByRole("checkbox", { name: "Confidence" }));
    await userEvent.click(screen.getByRole("button", { name: "Save and move" }));
    expect(leadsClient.patch).toHaveBeenCalledWith("l1", 1, { custom: { struggles: ["o1"] } });
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ stageId: "s-booked" })),
    );
    expect(dialog).not.toBeInTheDocument();
  });

  it("resolves null with the reason when the move is refused", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "You can't do that",
    });
    const onResult = run("s-sent");
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith(null));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "danger" }));
  });
});
