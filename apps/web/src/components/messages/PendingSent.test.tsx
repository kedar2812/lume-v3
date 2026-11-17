import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { markAway } from "@/lib/messages/pending";
import { PendingSent } from "./PendingSent";

vi.mock("@/lib/leads/client", () => ({ leadsClient: { confirmMessage: vi.fn(), move: vi.fn() } }));
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play: vi.fn() }) }));

describe("the shell's Sent? (bug hunt 2026-11-17)", () => {
  it("Yes moves the lead, and says so to the table or board on screen, so its stage shows", async () => {
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue({
      ok: true,
      status: 200,
      data: { moved: { fromStageId: "s-new", toStageId: "s-sent", toStageName: "Contacted" } },
    } as never);
    const heard = vi.fn();
    window.addEventListener("lume:lead-updated", (e) => heard((e as CustomEvent<string>).detail));
    render(<PendingSent />);
    markAway({ leadId: "l1", leadName: "Asha Rao", by: Symbol("gone") });
    act(() => void window.dispatchEvent(new Event("focus")));
    await userEvent.click(await screen.findByRole("button", { name: /Yes, sent/ }));
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith("l1"));
  });
});
