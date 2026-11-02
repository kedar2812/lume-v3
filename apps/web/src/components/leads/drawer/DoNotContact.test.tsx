import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { DoNotContact } from "./DoNotContact";

vi.mock("@/lib/leads/client", () => ({ leadsClient: { liftDoNotContact: vi.fn() } }));
const dnc = { at: "2026-11-01T18:10:00Z", by: null, reason: "Said stop on WhatsApp" };

beforeEach(() => vi.clearAllMocks());

/** A lead who asked not to be messaged, said on the lead, and lifted only by an admin (owner 2026-11-02). */
describe("do not contact on the lead", () => {
  it("says so with why; an admin lifts it, after a word on what it means", async () => {
    vi.mocked(leadsClient.liftDoNotContact).mockResolvedValue({
      ok: true,
      data: { doNotContact: null },
    } as never);
    const onLifted = vi.fn();
    render(<DoNotContact leadId="l1" leadName="Mrunal Desale" value={dnc} canLift onLifted={onLifted} />);
    const note = screen.getByRole("status", { name: "Do not contact" });
    expect(note).toHaveTextContent("Mrunal asked not to be messaged");
    expect(note).toHaveTextContent("Said stop on WhatsApp");
    await userEvent.click(screen.getByRole("button", { name: "Lift do not contact" }));
    expect(screen.getByText(/Only lift this if Mrunal asked to hear from you again/)).toBeInTheDocument();
    expect(leadsClient.liftDoNotContact).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Lift it" }));
    expect(leadsClient.liftDoNotContact).toHaveBeenCalledWith("l1");
    expect(onLifted).toHaveBeenCalled();
  });

  it("someone who isn't an admin reads who can lift it, and gets no button", () => {
    render(
      <DoNotContact
        leadId="l1"
        leadName="Mrunal Desale"
        value={dnc}
        canLift={false}
        onLifted={() => undefined}
      />,
    );
    expect(screen.getByText(/An admin can lift this/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lift do not contact" })).toBeNull();
  });

  it("refused: says why, and nothing changes", async () => {
    vi.mocked(leadsClient.liftDoNotContact).mockResolvedValue({
      ok: false,
      message: "Only an admin can.",
    } as never);
    const onLifted = vi.fn();
    render(<DoNotContact leadId="l1" leadName="Mrunal Desale" value={dnc} canLift onLifted={onLifted} />);
    await userEvent.click(screen.getByRole("button", { name: "Lift do not contact" }));
    await userEvent.click(screen.getByRole("button", { name: "Lift it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only an admin can.");
    expect(onLifted).not.toHaveBeenCalled();
  });
});
