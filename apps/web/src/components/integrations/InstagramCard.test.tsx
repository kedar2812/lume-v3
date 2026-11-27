import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { instagramClient } from "@/lib/instagram/client";
import type { IgAccount } from "@/lib/instagram/types";
import { InstagramCard } from "./InstagramCard";

vi.mock("@/lib/instagram/client", () => ({
  instagramClient: {
    setEnabled: vi.fn(),
    connect: vi.fn(),
    accounts: vi.fn(),
    setAccount: vi.fn(),
    disconnect: vi.fn(),
    people: vi.fn(),
    setAiGoal: vi.fn(),
  },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = { ok: false as const, status: 0, code: "OFFLINE", message: "offline" };
const account = (over: Partial<IgAccount> = {}): IgAccount => ({
  id: "a1",
  username: "harbour.studio",
  name: "Harbour Studio",
  owner: null,
  status: "active",
  problem: null,
  newDmCreatesLead: true,
  newDms: "team",
  limits: { newLeadsPerHour: 200, mediaMbPerPersonDay: 50, mediaMbPerDay: 2000 },
  sourceId: "s1",
  connectedAt: "2026-11-22T10:00:00.000Z",
  ...over,
});
const on = { enabled: true, available: true, inPlan: true };
const view = { googleSheets: {}, webhooks: [], instagram: on } as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(instagramClient.accounts).mockResolvedValue(ok({ accounts: [] }));
  vi.mocked(instagramClient.people).mockResolvedValue(
    ok({
      people: [
        { id: "u1", name: "Anusha Rao", active: true },
        { id: "u2", name: "Left Already", active: false },
      ],
    }),
  );
});

describe("the Instagram card (plan 2026-11-25-instagram-screens D1; canvas boards Main, Connect)", () => {
  it("off: one switch, what it does, and nothing asked of the server", () => {
    const { container } = render(<InstagramCard ig={{ ...on, enabled: false }} onView={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Instagram" })).toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute("src", "/brand/instagram.png");
    expect(screen.getByRole("switch", { name: "Instagram" })).not.toBeChecked();
    expect(screen.getByText("Not connected yet")).toBeInTheDocument();
    expect(instagramClient.accounts).not.toHaveBeenCalled();
  });

  it("not in the plan: the pill, the switch still, and no accounts asked for", () => {
    render(<InstagramCard ig={{ ...on, inPlan: false }} onView={vi.fn()} />);
    expect(screen.getByText("Not in this LUME’s plan")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(instagramClient.accounts).not.toHaveBeenCalled();
  });

  it("the relay isn't set up on this server: said, and the switch is still", () => {
    render(<InstagramCard ig={{ ...on, available: false }} onView={vi.fn()} />);
    expect(screen.getByText(/relay, which isn’t set up on this server yet/)).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("switching on asks the server and hands the new view up", async () => {
    const onView = vi.fn();
    vi.mocked(instagramClient.setEnabled).mockResolvedValue(ok(view));
    render(<InstagramCard ig={{ ...on, enabled: false }} onView={onView} />);
    await userEvent.click(screen.getByRole("switch", { name: "Instagram" }));
    expect(instagramClient.setEnabled).toHaveBeenCalledWith(true);
    expect(onView).toHaveBeenCalledWith(view);
  });

  it("a switch the server refuses says why on the card", async () => {
    vi.mocked(instagramClient.setEnabled).mockResolvedValue({ ...fail, message: "Instagram isn't set up." });
    render(<InstagramCard ig={{ ...on, enabled: false }} onView={vi.fn()} />);
    await userEvent.click(screen.getByRole("switch", { name: "Instagram" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Instagram isn't set up.");
  });

  it("on, none connected: what it does, and Connect an Instagram account", async () => {
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    expect(await screen.findByText("Turn Instagram comments and DMs into leads")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect an Instagram account" })).toBeInTheDocument();
  });

  it("while its accounts load, a placeholder holds the card's place", async () => {
    let answer: (v: unknown) => void = () => {};
    vi.mocked(instagramClient.accounts).mockReturnValue(new Promise((r) => (answer = r)) as never);
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    expect(screen.getByRole("status", { name: "Looking for connected accounts" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    answer(ok({ accounts: [] }));
    expect(await screen.findByText("Turn Instagram comments and DMs into leads")).toBeInTheDocument();
  });

  it("accounts that can't be read: said with Try again, which asks again", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValueOnce(fail as never);
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("LUME couldn't get your Instagram accounts");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Turn Instagram comments and DMs into leads")).toBeInTheDocument();
    expect(instagramClient.accounts).toHaveBeenCalledTimes(2);
  });

  it("the connect sheet says what happens before anything does, and goes to Instagram in this window", async () => {
    vi.mocked(instagramClient.connect).mockResolvedValue(ok({ url: "https://relay.test/ig/start?x" }));
    const assign = vi.fn();
    const was = window.location;
    Object.defineProperty(window, "location", { value: { ...was, assign }, configurable: true });
    try {
      render(<InstagramCard ig={on} onView={vi.fn()} />);
      await userEvent.click(await screen.findByRole("button", { name: "Connect an Instagram account" }));
      const sheet = screen.getByRole("dialog", { name: "Connect an Instagram account" });
      expect(sheet).toHaveTextContent("It must be a professional account (Business or Creator).");
      expect(sheet).toHaveTextContent("DMs, comments, story replies and ad clicks");
      expect(sheet).toHaveTextContent("Kept on your own server");
      expect(sheet).toHaveTextContent("Inside Instagram’s rules");
      expect(sheet).toHaveTextContent("Using ManyChat on this account too?");
      await userEvent.click(within(sheet).getByRole("button", { name: /Continue to Instagram/ }));
      expect(assign).toHaveBeenCalledWith("https://relay.test/ig/start?x");
    } finally {
      Object.defineProperty(window, "location", { value: was, configurable: true });
    }
  });

  it("a connect the server refuses stays on the sheet and says why", async () => {
    vi.mocked(instagramClient.connect).mockResolvedValue({ ...fail, message: "Switch Instagram on first." });
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect an Instagram account" }));
    const sheet = screen.getByRole("dialog", { name: "Connect an Instagram account" });
    await userEvent.click(within(sheet).getByRole("button", { name: /Continue to Instagram/ }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Switch Instagram on first.");
  });

  it("one account: its handle, name, whose it is and what happens to new people", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValue(ok({ accounts: [account()] }));
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Connected accounts" });
    expect(list).toHaveTextContent("@harbour.studio");
    expect(list).toHaveTextContent("Harbour Studio");
    expect(screen.getByText("1 account connected")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Whose account is @harbour.studio?" })).toHaveValue("");
    // Only people who use LUME now can own it.
    await waitFor(() => expect(screen.getByRole("option", { name: "Anusha Rao" })).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: "Left Already" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Become leads" })).toBeChecked();
    expect(screen.getByText(/Each becomes a lead under the account’s source/)).toBeInTheDocument();
  });

  it("two accounts: the summary counts them", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValue(
      ok({ accounts: [account(), account({ id: "a2", username: "maya.coach" })] }),
    );
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    expect(await screen.findByText("2 accounts connected")).toBeInTheDocument();
  });

  it("whose account: a person, then the business again, which sends null", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValue(ok({ accounts: [account()] }));
    vi.mocked(instagramClient.setAccount).mockResolvedValue(
      ok({ accounts: [account({ owner: { id: "u1", name: "Anusha Rao" } })] }),
    );
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    const pick = await screen.findByRole("combobox", { name: "Whose account is @harbour.studio?" });
    await waitFor(() => expect(screen.getByRole("option", { name: "Anusha Rao" })).toBeInTheDocument());
    await userEvent.selectOptions(pick, "u1");
    expect(instagramClient.setAccount).toHaveBeenCalledWith("a1", { ownerId: "u1" });
    await waitFor(() => expect(pick).toHaveValue("u1"));
    vi.mocked(instagramClient.setAccount).mockResolvedValue(ok({ accounts: [account()] }));
    await userEvent.selectOptions(pick, "");
    expect(instagramClient.setAccount).toHaveBeenLastCalledWith("a1", { ownerId: null });
  });

  it("new people wait in Not a lead yet: sent, and the note says for how long", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValue(ok({ accounts: [account()] }));
    vi.mocked(instagramClient.setAccount).mockResolvedValue(
      ok({ accounts: [account({ newDmCreatesLead: false })] }),
    );
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    await userEvent.click(await screen.findByRole("radio", { name: "Wait in Not a lead yet" }));
    expect(instagramClient.setAccount).toHaveBeenCalledWith("a1", { newDmCreatesLead: false });
    expect(await screen.findByText(/wait in Not a lead yet for 14 days/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Wait in Not a lead yet" })).toBeChecked();
  });

  it("a change the server refuses says why and keeps what was there", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValue(ok({ accounts: [account()] }));
    vi.mocked(instagramClient.setAccount).mockResolvedValue({
      ...fail,
      message: "Pick someone who uses LUME now.",
    });
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    const pick = await screen.findByRole("combobox", { name: "Whose account is @harbour.studio?" });
    await waitFor(() => expect(screen.getByRole("option", { name: "Anusha Rao" })).toBeInTheDocument());
    await userEvent.selectOptions(pick, "u1");
    expect(await screen.findByRole("alert")).toHaveTextContent("Pick someone who uses LUME now.");
    expect(pick).toHaveValue("");
  });

  it("disconnect asks first; Cancel sends nothing", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValue(ok({ accounts: [account()] }));
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect @harbour.studio" }));
    const sure = screen.getByRole("dialog", { name: "Disconnect @harbour.studio?" });
    expect(sure).toHaveTextContent("flows on it stop");
    await userEvent.click(within(sure).getByRole("button", { name: "Cancel" }));
    expect(instagramClient.disconnect).not.toHaveBeenCalled();
  });

  it("disconnect, confirmed: gone from the list", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValue(ok({ accounts: [account()] }));
    vi.mocked(instagramClient.disconnect).mockResolvedValue(ok({ accounts: [] }));
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect @harbour.studio" }));
    const sure = screen.getByRole("dialog", { name: "Disconnect @harbour.studio?" });
    await userEvent.click(within(sure).getByRole("button", { name: "Disconnect" }));
    expect(instagramClient.disconnect).toHaveBeenCalledWith("a1");
    expect(await screen.findByText("Turn Instagram comments and DMs into leads")).toBeInTheDocument();
  });

  it("an account that needs connecting again: the problem, and Connect again", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValue(
      ok({
        accounts: [account({ status: "needs_attention", problem: "Instagram's sign-in for it ended." })],
      }),
    );
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    expect(await screen.findByText("Instagram's sign-in for it ended.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect @harbour.studio again" }));
    expect(screen.getByRole("dialog", { name: "Connect an Instagram account" })).toBeInTheDocument();
  });

  it("connected: links to its flows and Not a lead yet, and the order of who answers", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValue(ok({ accounts: [account()] }));
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    expect(await screen.findByRole("link", { name: "Flows" })).toHaveAttribute("href", "/instagram/flows");
    expect(screen.getByRole("link", { name: "Not a lead yet" })).toHaveAttribute("href", "/leads/not-yet");
    const order = screen.getByRole("list", { name: "Who answers what" });
    expect(
      within(order)
        .getAllByRole("listitem")
        .map((li) => li.querySelector("b")?.textContent),
    ).toEqual([
      "Your team, once someone steps in",
      "LUME AI, in a conversation it has",
      "A flow, for what it was made for",
      "LUME AI, on an account set to it",
      "Your team, for everything else",
    ]);
  });

  const aiOn = {
    ok: true,
    goal: { kind: "brief" as const, text: "Answer their questions" },
    stages: [{ id: "st1", name: "Call booked" }],
  };

  it("Who answers new DMs: LUME AI chosen, sent, and what it aims for can be set", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValue(ok({ accounts: [account()], ai: aiOn }));
    vi.mocked(instagramClient.setAccount).mockResolvedValue(
      ok({ accounts: [account({ newDms: "ai" })], ai: aiOn }),
    );
    vi.mocked(instagramClient.setAiGoal).mockResolvedValue(ok({ goal: { kind: "stage", stageId: "st1" } }));
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    expect(await screen.findByText("Your team answers DMs no flow claims.")).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "What LUME AI aims for on Instagram" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "LUME AI" }));
    expect(instagramClient.setAccount).toHaveBeenCalledWith("a1", { newDms: "ai" });
    expect(
      await screen.findByText(/LUME AI answers DMs no flow claims, within Instagram’s 24 hours/),
    ).toBeInTheDocument();
    const goal = screen.getByRole("combobox", { name: "What LUME AI aims for on Instagram" });
    expect(goal).toHaveValue("words");
    expect(screen.getByRole("textbox", { name: "LUME AI's goal, in your words" })).toHaveValue(
      "Answer their questions",
    );
    await userEvent.selectOptions(goal, "st1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(instagramClient.setAiGoal).toHaveBeenCalledWith({ kind: "stage", stageId: "st1" });
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("LUME AI can't answer here: the choice is off, with why; one chosen before says the team answers meanwhile", async () => {
    const off = {
      ok: false,
      why: "LUME AI is switched off. An admin can switch it on in Settings → Integrations.",
      goal: aiOn.goal,
      stages: [],
    };
    vi.mocked(instagramClient.accounts).mockResolvedValue(ok({ accounts: [account()], ai: off }));
    const { unmount } = render(<InstagramCard ig={on} onView={vi.fn()} />);
    expect(await screen.findByText(off.why)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "LUME AI" })).toBeDisabled();
    unmount();
    vi.mocked(instagramClient.accounts).mockResolvedValue(
      ok({ accounts: [account({ newDms: "ai" })], ai: off }),
    );
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    expect(
      await screen.findByText(`LUME AI can’t answer now, so your team does. ${off.why}`),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Your team" })).not.toBeDisabled();
    expect(
      screen.queryByRole("combobox", { name: "What LUME AI aims for on Instagram" }),
    ).not.toBeInTheDocument();
  });

  it("LUME AI is never offered unless the server says it can answer there (no over-promising)", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValue(ok({ accounts: [account()] }));
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    await screen.findByRole("list", { name: "Connected accounts" });
    expect(screen.getByRole("radio", { name: "LUME AI" })).toBeDisabled();
    expect(screen.getByText("LUME AI can’t answer Instagram here yet.")).toBeInTheDocument();
  });

  it("a long handle keeps its whole name for the pointer (Instagram allows 30 characters, names 150)", async () => {
    const long = "a".repeat(30);
    vi.mocked(instagramClient.accounts).mockResolvedValue(
      ok({ accounts: [account({ username: long, name: "N".repeat(150) })] }),
    );
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    expect(await screen.findByText(`@${long}`)).toHaveAttribute("title", `@${long}`);
  });

  it("while its accounts load, the summary says it's looking; never Not connected yet for one that is", async () => {
    vi.mocked(instagramClient.accounts).mockReturnValue(new Promise(() => {}) as never);
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    expect(screen.getByText("Looking for accounts…")).toBeInTheDocument();
    expect(screen.queryByText("Not connected yet")).toBeNull();
  });

  it("Disconnect pressed twice sends one", async () => {
    vi.mocked(instagramClient.accounts).mockResolvedValue(ok({ accounts: [account()] }));
    let answer: (v: unknown) => void = () => {};
    vi.mocked(instagramClient.disconnect).mockReturnValue(new Promise((r) => (answer = r)) as never);
    render(<InstagramCard ig={on} onView={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect @harbour.studio" }));
    const sure = screen.getByRole("dialog", { name: "Disconnect @harbour.studio?" });
    await userEvent.dblClick(within(sure).getByRole("button", { name: "Disconnect" }));
    answer(ok({ accounts: [] }));
    expect(await screen.findByText("Turn Instagram comments and DMs into leads")).toBeInTheDocument();
    expect(instagramClient.disconnect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
