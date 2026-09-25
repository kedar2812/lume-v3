import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { testCatalog } from "@/lib/leads/test-catalog";
import { fakeSession } from "@/server/session";
import { BulkBar } from "./BulkBar";
import { CatalogProvider } from "./CatalogProvider";

vi.mock("@/lib/leads/client", () => ({ leadsClient: { bulk: vi.fn() } }));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
const admin = fakeSession({
  permissions: [
    { key: "leads.view", scope: "all" },
    { key: "leads.bulk_edit", scope: "all" },
    { key: "leads.assign", scope: "all" },
    { key: "leads.delete", scope: "all" },
    { key: "leads.change_stage", scope: "all" },
  ],
});
const bar = (selected = ["a", "b", "c", "d"]) => {
  const onDone = vi.fn();
  render(
    <CatalogProvider catalog={testCatalog()}>
      <BulkBar session={admin} selected={selected} onDone={onDone} onClear={vi.fn()} />
    </CatalogProvider>,
  );
  return onDone;
};

beforeEach(() => vi.clearAllMocks());

describe("BulkBar", () => {
  it("moves the selection and reports what was skipped and why", async () => {
    vi.mocked(leadsClient.bulk).mockResolvedValue({
      ok: true,
      status: 200,
      data: { updated: ["a", "b", "c"], skipped: [{ id: "d", code: "REQUIRED_FIELDS" }] },
    });
    const onDone = bar();
    expect(screen.getByText("4 selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Move to stage" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Message sent" }));
    expect(leadsClient.bulk).toHaveBeenCalledWith(["a", "b", "c", "d"], { type: "stage", stageId: "s-sent" });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "3 moved, 1 skipped: missing required fields" }),
    );
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ skipped: [{ id: "d", code: "REQUIRED_FIELDS" }] }),
    );
  });

  it("asks for a lost reason before a bulk move to Lost", async () => {
    vi.mocked(leadsClient.bulk).mockResolvedValue({
      ok: true,
      status: 200,
      data: { updated: ["a"], skipped: [] },
    });
    bar(["a"]);
    await userEvent.click(screen.getByRole("button", { name: "Move to stage" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Lost" }));
    await userEvent.click(await screen.findByRole("radio", { name: "Price" }));
    await userEvent.click(screen.getByRole("button", { name: "Mark 1 as lost" }));
    expect(leadsClient.bulk).toHaveBeenCalledWith(["a"], {
      type: "stage",
      stageId: "s-lost",
      lostReasonId: "r-price",
    });
  });

  it("makes deleting a deliberate act, naming how many", async () => {
    vi.mocked(leadsClient.bulk).mockResolvedValue({
      ok: true,
      status: 200,
      data: { updated: ["a", "b"], skipped: [] },
    });
    bar(["a", "b"]);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(leadsClient.bulk).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete 2 leads" }));
    expect(leadsClient.bulk).toHaveBeenCalledWith(["a", "b"], { type: "delete" });
  });
});
