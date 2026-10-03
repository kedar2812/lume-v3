import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCatalog } from "@/lib/leads/test-catalog";
import { auditClient } from "@/lib/settings/audit";
import { AuditLog } from "./AuditLog";

vi.mock("@/lib/settings/audit", async (orig) => ({
  ...(await orig<typeof import("@/lib/settings/audit")>()),
  auditClient: { list: vi.fn() },
}));

const reveal = {
  id: 10,
  at: "2026-09-25T10:00:00Z",
  action: "lead.contact.reveal",
  actorUserId: "u-riya",
  actorIp: null,
  entityType: "lead",
  entityId: "l1",
  diff: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auditClient.list).mockResolvedValue({
    ok: true,
    status: 200,
    data: { entries: [], nextCursor: null },
  });
});

describe("AuditLog", () => {
  it("reads the audit log in words, filters by person and action, and pages with the cursor", async () => {
    vi.mocked(auditClient.list).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { entries: [reveal], nextCursor: 10 },
    });
    render(<AuditLog people={testCatalog().people} />);
    expect(await screen.findByText("Riya Sharma revealed a lead’s contact")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open lead" })).toHaveAttribute("href", "/leads?lead=l1");
    expect(screen.getByText("The audit log can’t be edited or deleted, by anyone.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    expect(auditClient.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 10 }));

    await userEvent.selectOptions(screen.getByLabelText("Who"), "u-tas");
    expect(auditClient.list).toHaveBeenLastCalledWith({ actorUserId: "u-tas" });
    await userEvent.selectOptions(screen.getByLabelText("What"), "lead.delete");
    expect(auditClient.list).toHaveBeenLastCalledWith({ actorUserId: "u-tas", action: "lead.delete" });
    expect(await screen.findByText("Nothing matches these filters.")).toBeInTheDocument();
  });

  it("6A: opened from an alert, it starts filtered to that person", async () => {
    render(<AuditLog people={testCatalog().people} initialActor="u-riya" />);
    await screen.findByLabelText("Who");
    expect(auditClient.list).toHaveBeenCalledWith({ actorUserId: "u-riya" });
  });

  it("6C: opened from a Security figure, it starts on that action and day, and can show every day", async () => {
    render(
      <AuditLog people={testCatalog().people} initialAction="lead.contact.reveal" initialDay="2026-10-03" />,
    );
    await screen.findByLabelText("Who");
    expect(auditClient.list).toHaveBeenCalledWith({ action: "lead.contact.reveal", day: "2026-10-03" });
    expect(screen.getByText("Only October 3, Saturday")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show every day" }));
    expect(auditClient.list).toHaveBeenLastCalledWith({ action: "lead.contact.reveal" });
    expect(screen.queryByText("Only October 3, Saturday")).not.toBeInTheDocument();
  });
});
