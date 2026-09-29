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
    { key: "leads.edit", scope: "all" },
  ],
});
const bar = (
  selected = ["a", "b", "c", "d"],
  o: { phoneFixable?: boolean; session?: ReturnType<typeof fakeSession> } = {},
) => {
  const onDone = vi.fn();
  render(
    <CatalogProvider catalog={testCatalog()}>
      <BulkBar
        session={o.session ?? admin}
        selected={selected}
        phoneFixable={o.phoneFixable}
        onDone={onDone}
        onClear={vi.fn()}
      />
    </CatalogProvider>,
  );
  return onDone;
};

beforeEach(() => vi.clearAllMocks());

describe("BulkBar", () => {
  it("4C: someone who may run a send queue but not edit in bulk gets Message, and only Message", () => {
    const rep = fakeSession({
      permissions: [
        { key: "leads.view", scope: "own" },
        { key: "leads.edit", scope: "own" },
        { key: "leads.change_stage", scope: "own" },
        { key: "leads.delete", scope: "own" },
        { key: "messages.send", scope: "own" },
        { key: "messages.send_queue", scope: "own" },
      ],
    });
    bar(["a", "b"], { session: rep, phoneFixable: true });
    expect(screen.getByRole("button", { name: "Message" })).toBeInTheDocument();
    for (const name of ["Move to stage", "Assign", "Tags", "Delete"])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /country/i })).not.toBeInTheDocument();
  });

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

  it("keeps the note written for a bulk move to Lost", async () => {
    vi.mocked(leadsClient.bulk).mockResolvedValue({
      ok: true,
      status: 200,
      data: { updated: ["a"], skipped: [] },
    });
    bar(["a"]);
    await userEvent.click(screen.getByRole("button", { name: "Move to stage" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Lost" }));
    await userEvent.click(await screen.findByRole("radio", { name: "Price" }));
    await userEvent.type(screen.getByLabelText("Note (optional)"), "Chose a cheaper coach");
    await userEvent.click(screen.getByRole("button", { name: "Mark 1 as lost" }));
    expect(leadsClient.bulk).toHaveBeenCalledWith(["a"], {
      type: "stage",
      stageId: "s-lost",
      lostReasonId: "r-price",
      lostNote: "Chose a cheaper coach",
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

  it("gives unreadable numbers a country, starting from the business's, and reports the result", async () => {
    vi.mocked(leadsClient.bulk).mockResolvedValue({
      ok: true,
      status: 200,
      data: { updated: ["l1"], skipped: [{ id: "l2", code: "STILL_INVALID" }] },
    });
    bar(["l1", "l2"], { phoneFixable: true });
    await userEvent.click(screen.getByRole("button", { name: "Set country…" }));
    expect(screen.getByRole("button", { name: "Country: United Arab Emirates" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Country:/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Search countries" }), "india{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Set country" }));
    expect(leadsClient.bulk).toHaveBeenCalledWith(["l1", "l2"], { type: "set_phone_country", country: "IN" });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "1 fixed, 1 skipped: still not a number LUME can read" }),
    );
  });

  it("offers Set country only when a selected number needs one", async () => {
    bar(["a"]);
    expect(screen.queryByRole("button", { name: "Set country…" })).not.toBeInTheDocument();
  });

  it("goes back to the bar on Cancel without changing anything", async () => {
    bar(["a"], { phoneFixable: true });
    await userEvent.click(screen.getByRole("button", { name: "Set country…" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Set country…" })).toBeInTheDocument();
    expect(leadsClient.bulk).not.toHaveBeenCalled();
  });
});
