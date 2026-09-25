import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { EMPTY_FILTERS } from "@/lib/leads/filters";
import { testCatalog, testLead } from "@/lib/leads/test-catalog";
import { fakeSession } from "@/server/session";
import { BoardScreen } from "./BoardScreen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/pipeline",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/leads/client", () => ({
  leadsClient: { move: vi.fn(), list: vi.fn(), counts: vi.fn(), get: vi.fn(), activities: vi.fn() },
}));
const play = vi.fn();
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play }) }));

const cat = testCatalog();
const pipeline = cat.pipelines[0]!;
const board = (over: Partial<Parameters<typeof BoardScreen>[0]> = {}) =>
  render(
    <BoardScreen
      session={fakeSession({
        permissions: [
          { key: "leads.view", scope: "own" },
          { key: "leads.change_stage", scope: "own" },
        ],
      })}
      catalog={cat}
      pipeline={pipeline}
      filters={EMPTY_FILTERS}
      columns={{
        "s-new": { items: [testLead()], nextCursor: null },
        "s-sent": { items: [], nextCursor: null },
      }}
      counts={{ "s-new": 1, "s-sent": 0 }}
      {...over}
    />,
  );
const column = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name}`) });

beforeEach(() => vi.clearAllMocks());

describe("BoardScreen", () => {
  it("shows one column per stage with its count", () => {
    board();
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual([
      "New, 1 lead",
      "Message sent, 0 leads",
      "Call booked, 0 leads",
      "Won, 0 leads",
      "Lost, 0 leads",
    ]);
    expect(within(column("New")).getByRole("button", { name: /Aisha Khan/ })).toBeInTheDocument();
  });

  it("moves a card with the keyboard alone and keeps the counts true", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({
      ok: true,
      status: 200,
      data: { lead: testLead({ stageId: "s-sent" }) },
    });
    board();
    within(column("New"))
      .getByRole("button", { name: /Aisha Khan/ })
      .focus();
    await userEvent.keyboard(" ");
    expect(screen.getByRole("status")).toHaveTextContent(/picked up aisha khan/i);
    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(leadsClient.move).toHaveBeenCalledWith("l1", "s-sent", {});
    await vi.waitFor(() =>
      expect(within(column("Message sent")).getByRole("button", { name: /Aisha Khan/ })).toBeInTheDocument(),
    );
    expect(column("New")).toHaveAccessibleName("New, 0 leads");
    expect(column("Message sent")).toHaveAccessibleName("Message sent, 1 lead");
  });

  it("puts the card back when the move is refused, with the counts restored", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "no",
    });
    board();
    within(column("New"))
      .getByRole("button", { name: /Aisha Khan/ })
      .focus();
    await userEvent.keyboard(" {ArrowRight}{Enter}");
    await vi.waitFor(() =>
      expect(within(column("New")).getByRole("button", { name: /Aisha Khan/ })).toBeInTheDocument(),
    );
    expect(column("New")).toHaveAccessibleName("New, 1 lead");
    expect(column("Message sent")).toHaveAccessibleName("Message sent, 0 leads");
  });

  it("asks for the reason when a card is dropped on Lost, and cancelling puts it back", async () => {
    board();
    within(column("New"))
      .getByRole("button", { name: /Aisha Khan/ })
      .focus();
    await userEvent.keyboard(" {ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(within(column("New")).getByRole("button", { name: /Aisha Khan/ })).toBeInTheDocument();
    expect(leadsClient.move).not.toHaveBeenCalled();
  });

  it("plays the win chime only for a move into Won", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({
      ok: true,
      status: 200,
      data: { lead: testLead({ stageId: "s-won" }) },
    });
    board();
    within(column("New"))
      .getByRole("button", { name: /Aisha Khan/ })
      .focus();
    await userEvent.keyboard(" {ArrowRight}{ArrowRight}{ArrowRight}{Enter}");
    await vi.waitFor(() => expect(play).toHaveBeenCalledWith("won"));
  });

  it("offers no pick-up on a card the person can't move", async () => {
    board({
      columns: {
        "s-new": { items: [testLead({ can: { ...testLead().can, move: false } })], nextCursor: null },
      },
    });
    within(column("New"))
      .getByRole("button", { name: /Aisha Khan/ })
      .focus();
    await userEvent.keyboard(" ");
    expect(screen.queryByText(/picked up/i)).not.toBeInTheDocument();
  });
  it("opens the drawer on a click, never on the Space that picks a card up", async () => {
    vi.mocked(leadsClient.get).mockResolvedValue({ ok: true, status: 200, data: { lead: testLead() } });
    board();
    const card = within(column("New")).getByRole("button", { name: /Aisha Khan/ });
    card.focus();
    await userEvent.keyboard(" ");
    expect(leadsClient.get).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("status")).toHaveTextContent(/put back/i);
    await userEvent.click(card);
    expect(await screen.findByRole("dialog", { name: "Aisha Khan" })).toBeInTheDocument();
  });
});
