import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatClient, type ChatList, type MessageView } from "@/lib/chat/client";
import { ChatScreen } from "./ChatScreen";
import { askedFor, optionsFor } from "./MentionMenu";

/** Naming people in chat, on the screen (plan 2026-11-25-team-chat-2b, Task 2). */
type E = { c?: string; e: string; m?: number; u?: string; t?: number };
const stream = vi.hoisted(() => ({ chat: new Set<(e: E) => void>() }));
vi.mock("@/lib/notifications/stream", () => ({
  subscribeChat: (l: never) => {
    stream.chat.add(l);
    return () => stream.chat.delete(l);
  },
  subscribePresence: () => () => undefined,
}));
vi.mock("@/lib/chat/client", async (orig) => {
  const real = await orig<typeof import("@/lib/chat/client")>();
  return {
    ...real,
    chatClient: Object.fromEntries(Object.keys(real.chatClient).map((k) => [k, vi.fn()])),
  };
});

const id = (n: number) => `0190e0c0-0000-7000-8000-0000000${String(n).padStart(5, "0")}`;
const [ME, SANA, RAHUL, RAHUL2, OLD, CH, CH2, TEAM] = [1, 2, 3, 4, 5, 50, 51, 90].map(id) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
const people = [
  { id: ME, name: "Maya Kapoor", avatar: null, active: true },
  { id: SANA, name: "Sana Iqbal", avatar: null, active: true },
  { id: RAHUL, name: "Rahul Mehta", avatar: null, active: true },
  { id: RAHUL2, name: "Rahul Mehta", avatar: null, active: true },
  { id: OLD, name: "Ravi Old", avatar: null, active: false },
];
const can = {
  members: [ME, SANA, RAHUL, RAHUL2, OLD],
  teams: [{ id: TEAM, name: "Closers" }],
  everyone: true,
};
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const list = (): ChatList => ({
  channels: [CH, CH2].map((c, i) => ({
    id: c,
    kind: "channel",
    name: i ? "deals" : "sales",
    topic: null,
    unread: 0,
    muted: false,
    lastAt: null,
  })),
  direct: [],
  leads: [],
  folds: { channels: false, direct: false, leads: false },
  threads: { any: false, unread: 0 },
  unread: 0,
});
const msg = (n: number, authorId: string, body: string, o: Partial<MessageView> = {}): MessageView => ({
  id: n,
  conversationId: CH,
  authorId,
  clientId: null,
  kind: "text",
  body,
  replyTo: null,
  threadRoot: null,
  alsoSent: false,
  thread: null,
  files: [],
  reactions: [],
  editedAt: null,
  deletedAt: null,
  createdAt: new Date(Date.now() - 60_000 + n * 1000).toISOString(),
  ...o,
});
const page = (...messages: MessageView[]) => ok({ messages, members: [], more: false, lastReadId: 9 });
const screenOf = (o: { openId?: string; thread?: number; asked?: string } = {}) => (
  <ChatScreen initial={list()} people={people} me={ME} zone="Asia/Kolkata" openId={CH} {...o} />
);
const box = () => screen.findByRole("textbox", { name: "Message #sales" });
const menu = () => screen.findByRole("listbox", { name: "Mention someone" });
/** Once whom one may name is here. */
const ready = async () => {
  const b = await box();
  await waitFor(() => expect(chatClient.mentionable).toHaveBeenCalled());
  await act(async () => undefined);
  return b;
};
const sent = () => vi.mocked(chatClient.send).mock.lastCall![1].body;

beforeEach(() => {
  vi.clearAllMocks();
  for (const f of Object.values(chatClient))
    vi.mocked(f as () => unknown).mockResolvedValue(ok(undefined) as never);
  vi.mocked(chatClient.list).mockResolvedValue(ok(list()));
  vi.mocked(chatClient.online).mockResolvedValue(ok({ online: [] }));
  vi.mocked(chatClient.mentionable).mockResolvedValue(ok(can));
  vi.mocked(chatClient.page).mockResolvedValue(page(msg(1, SANA, "Morning")));
  vi.mocked(chatClient.send).mockImplementation(async (_c, b) =>
    ok(msg(20, ME, b.body!, { clientId: b.clientId })),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the menu", () => {
  it("an @ brings the names that fit; Enter takes one, and the message names them", async () => {
    render(screenOf());
    const b = await ready();
    await userEvent.type(b, "Ask @sa");
    expect(
      within(await menu())
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["SISana Iqbal"]);
    await userEvent.keyboard("{Enter}");
    expect(chatClient.send).not.toHaveBeenCalled();
    expect(b).toHaveValue("Ask @Sana Iqbal ");
    expect((b as HTMLTextAreaElement).selectionStart).toBe(16);
    await userEvent.type(b, "please{Enter}");
    await waitFor(() => expect(chatClient.send).toHaveBeenCalled());
    expect(sent()).toBe(`Ask <@${SANA}> please`);
  });

  it("the arrows move and go round, Tab takes, Escape shuts it and Enter then sends", async () => {
    render(screenOf());
    const b = await ready();
    await userEvent.type(b, "@");
    const options = within(await menu()).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "RMRahul Mehta",
      "RMRahul Mehta",
      "SISana Iqbal",
      "@ClosersTeam",
      "@channelEveryone here",
    ]);
    expect(b).toHaveAttribute("aria-activedescendant", options[0]!.id);
    await userEvent.keyboard("{ArrowUp}");
    expect(b).toHaveAttribute("aria-activedescendant", options[4]!.id);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Tab}");
    expect(b).toHaveValue("@Sana Iqbal ");
    await userEvent.type(b, "@clo");
    await menu();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.keyboard("s{Enter}");
    await waitFor(() => expect(chatClient.send).toHaveBeenCalled());
    expect(sent()).toBe(`<@${SANA}> @clos`);
  });

  it("one name that goes on into another: the one chosen is who's named, and Enter sends", async () => {
    vi.mocked(chatClient.mentionable).mockResolvedValue(
      ok({
        members: [],
        teams: ["Sales", "Sales North"].map((name, i) => ({ id: id(91 + i), name })),
        everyone: false,
      }),
    );
    render(screenOf());
    const b = await ready();
    await userEvent.type(b, "@sales{Enter}");
    expect(b).toHaveValue("@Sales ");
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(sent()).toBe(`<@team:${id(91)}>`));
  });

  it("two of one name, the first rubbed out: the other is who's named", async () => {
    render(screenOf());
    const b = await ready();
    await userEvent.type(b, "@rahul{Enter}@rahul");
    await menu();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    (b as HTMLTextAreaElement).setSelectionRange(0, 13);
    await userEvent.keyboard("{Backspace}{Enter}");
    await waitFor(() => expect(chatClient.send).toHaveBeenCalled());
    expect(sent()).toBe(`<@${RAHUL2}>`);
  });

  it("a press takes one too, and the box keeps the keyboard", async () => {
    render(screenOf());
    const b = await ready();
    await userEvent.type(b, "@clo");
    await userEvent.click(within(await menu()).getByRole("option", { name: /Closers/ }));
    expect(b).toHaveValue("@Closers ");
    await waitFor(() => expect(b).toHaveFocus());
    await userEvent.type(b, "go{Enter}");
    await waitFor(() => expect(sent()).toBe(`<@team:${TEAM}> go`));
  });

  it("two people of one name are told apart by the order they stand in", async () => {
    render(screenOf());
    const b = await ready();
    await userEvent.type(b, "@rahul");
    await menu();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    // The first of them is now written before the second.
    (b as HTMLTextAreaElement).setSelectionRange(0, 0);
    await userEvent.type(b, "@rahul", { initialSelectionStart: 0, initialSelectionEnd: 0 });
    await menu();
    await userEvent.keyboard("{Enter}");
    await userEvent.type(b, "{Enter}");
    await waitFor(() => expect(chatClient.send).toHaveBeenCalled());
    expect(sent()).toBe(`<@${RAHUL}> <@${RAHUL2}>`);
  });

  it("one only typed stays words, and a name taken out again names nobody", async () => {
    render(screenOf());
    const b = await ready();
    await userEvent.type(b, "@Sana Iqbal{Escape} hi");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(sent()).toBe("@Sana Iqbal hi"));
    await userEvent.type(b, "@sana{Enter}");
    await userEvent.clear(b);
    await userEvent.type(b, "never mind{Enter}");
    await waitFor(() => expect(sent()).toBe("never mind"));
  });

  it("kept with what's half written, and through an edit that's given up", async () => {
    vi.mocked(chatClient.page).mockResolvedValue(page(msg(1, ME, `Hello <@${SANA}>`)));
    vi.mocked(chatClient.edit).mockImplementation(async (m, body) => ok(msg(m, ME, body)));
    render(screenOf());
    const b = await ready();
    await userEvent.type(b, "@clo{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(b).toHaveValue("Hello @Sana Iqbal");
    await userEvent.type(b, "!{Enter}");
    await waitFor(() => expect(chatClient.edit).toHaveBeenCalledWith(1, `Hello <@${SANA}>!`));
    await waitFor(() => expect(b).toHaveValue("@Closers "));
    await userEvent.click(screen.getByRole("button", { name: "deals" }));
    await userEvent.click(screen.getByRole("button", { name: "sales" }));
    const again = await ready();
    expect(again).toHaveValue("@Closers ");
    await userEvent.type(again, "go{Enter}");
    await waitFor(() => expect(sent()).toBe(`<@team:${TEAM}> go`));
  });

  it("the @ button starts one", async () => {
    render(screenOf());
    const b = await ready();
    await userEvent.type(b, "Hi");
    await userEvent.click(screen.getByRole("button", { name: "Mention someone" }));
    expect(b).toHaveValue("Hi @");
    await menu();
  });

  it("names nobody who can't be: oneself, someone who left, everyone where that's not allowed", () => {
    const all = new Map(people.map((p) => [p.id, { name: p.name, active: p.active }]));
    const names = (words: string, c = can) => optionsFor(words, c, all, ME).map((o) => o.name);
    expect(names("")).toEqual(["Rahul Mehta", "Rahul Mehta", "Sana Iqbal", "Closers", "channel"]);
    expect(names("", { ...can, everyone: false })).not.toContain("channel");
    expect(names("", { ...can, members: [SANA] })).toEqual(["Sana Iqbal", "Closers", "channel"]);
    // About a lead: anyone, checked as it's sent.
    expect(names("rah", { ...can, members: null as never })).toEqual(["Rahul Mehta", "Rahul Mehta"]);
    expect(names("IQB")).toEqual(["Sana Iqbal"]);
    expect(names("sana i")).toEqual(["Sana Iqbal"]);
    expect(names("ana")).toEqual([]);
    const many = new Map(Array.from({ length: 30 }, (_, i) => [id(200 + i), { name: `Zed ${i}` }]));
    expect(optionsFor("z", { ...can, members: [...many.keys()] }, many, ME)).toHaveLength(8);
    const marks = new Map([[SANA, { name: "Zoë Iñárritu" }]]);
    expect(optionsFor("zoe", can, marks, ME)).toHaveLength(1);
  });

  it("an @ inside a word, or with a space after it, isn't one", () => {
    expect(askedFor("mail me@ex", 10)).toBeNull();
    expect(askedFor("at @ home", 9)).toBeNull();
    expect(askedFor("hi @ma", 6)).toEqual({ at: 3, words: "ma" });
    expect(askedFor("hi @ma and", 6)).toEqual({ at: 3, words: "ma" });
    expect(askedFor("(@ma", 4)).toEqual({ at: 1, words: "ma" });
    expect(askedFor(`@${"x".repeat(41)}`, 42)).toBeNull();
    expect(askedFor("@a\nb", 4)).toBeNull();
  });
});

describe("a message's words", () => {
  it("names, marks and links as they're read; a name is never an id", async () => {
    vi.mocked(chatClient.page).mockResolvedValue(
      page(
        msg(
          1,
          SANA,
          `<@${ME}> <@${RAHUL}> <@team:${TEAM}> <@${id(77)}> <@channel> *bold* \`x<y\` https://example.com/a`,
        ),
      ),
    );
    render(screenOf());
    await ready();
    const m = screen.getByRole("group", { name: /^Sana Iqbal/ });
    expect(m).toHaveTextContent(
      "@Maya Kapoor @Rahul Mehta @Closers @someone @channel bold x<y https://example.com/a",
    );
    expect(m.textContent).not.toContain("0190e0c0");
    expect(within(m).getByText("@Maya Kapoor")).toHaveAttribute("data-me");
    expect(within(m).getByText("@Rahul Mehta")).not.toHaveAttribute("data-me");
    expect(within(m).getByText("bold").tagName).toBe("STRONG");
    const a = within(m).getByRole("link", { name: "https://example.com/a" });
    expect(a).toHaveAttribute("href", "https://example.com/a");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("a quote and an answer say names, never ids", async () => {
    vi.mocked(chatClient.page).mockResolvedValue(
      page(
        msg(1, SANA, `Over to <@${RAHUL}>`),
        msg(2, SANA, "Yes", { replyTo: { id: 1, authorId: SANA, body: `Over to <@${RAHUL}>` } }),
      ),
    );
    render(screenOf());
    await ready();
    expect(screen.getAllByText("Over to @Rahul Mehta")).toHaveLength(1);
    await userEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]!);
    expect(screen.getByText("Replying to Sana Iqbal: Over to @Rahul Mehta")).toBeInTheDocument();
  });

  it("whoever it names that wasn't told is said to its sender, and stays said when it's read again", async () => {
    vi.mocked(chatClient.send).mockImplementation(async (_c, b) =>
      ok(msg(20, ME, b.body!, { clientId: b.clientId, notTold: [RAHUL] })),
    );
    render(screenOf());
    const b = await ready();
    await userEvent.type(b, "Hi{Enter}");
    await screen.findByText("Not told, as they can't read this: Rahul Mehta");
    vi.mocked(chatClient.page).mockResolvedValue(page(msg(20, ME, "Hi")));
    act(() => stream.chat.forEach((l) => l({ c: CH, e: "reaction", m: 20 })));
    await waitFor(() => expect(chatClient.page).toHaveBeenLastCalledWith(CH, { after: 19 }), {
      timeout: 4000,
    });
    await act(async () => undefined);
    expect(screen.getByText("Not told, as they can't read this: Rahul Mehta")).toBeInTheDocument();
  });

  it("too long is judged by what is sent, ids and all", async () => {
    render(screenOf());
    const b = await ready();
    await userEvent.type(b, "@sana{Enter}");
    await userEvent.paste("x".repeat(3980));
    expect(screen.getByText("A message can be at most 4,000 characters.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});

describe("what the bell is told", () => {
  it("opening a conversation says it's read even with nothing new, and an edit that names me says so again", async () => {
    vi.mocked(chatClient.page).mockResolvedValue({
      ...page(msg(1, SANA, "Morning")),
      data: { ...page(msg(1, SANA, "Morning")).data, lastReadId: 1 },
    });
    render(screenOf());
    await ready();
    await waitFor(() => expect(chatClient.read).toHaveBeenCalledWith(CH, 1));
    vi.mocked(chatClient.read).mockClear();
    vi.mocked(chatClient.page).mockResolvedValue(page(msg(1, SANA, `Morning <@${ME}>`)));
    act(() => stream.chat.forEach((l) => l({ c: CH, e: "edited", m: 1 })));
    await waitFor(() => expect(chatClient.read).toHaveBeenCalledWith(CH, 1), { timeout: 5000 });
  });
});

describe("named while looking", () => {
  it("a message that names me is said read at once, not when the mark's next turn comes", async () => {
    vi.mocked(chatClient.page).mockResolvedValue({
      ...page(msg(1, SANA, "Morning")),
      data: { ...page(msg(1, SANA, "Morning")).data, lastReadId: 1 },
    });
    render(screenOf());
    await ready();
    await waitFor(() => expect(chatClient.read).toHaveBeenCalledWith(CH, 1));
    vi.mocked(chatClient.page).mockResolvedValue(page(msg(2, SANA, `<@${ME}> look`)));
    const t0 = Date.now();
    act(() => stream.chat.forEach((l) => l({ c: CH, e: "message", m: 2, u: SANA })));
    await waitFor(() => expect(chatClient.read).toHaveBeenCalledWith(CH, 2), { timeout: 2500 });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("opened from the bell", () => {
  it("while Chat is on screen: the conversation and the thread it asks for, and again when asked again", async () => {
    vi.mocked(chatClient.thread).mockResolvedValue(
      ok({
        root: 7,
        conversationId: CH2,
        following: true,
        messages: [msg(7, SANA, "Root")],
        members: [],
        more: false,
        lastReadId: 7,
      }),
    );
    const { rerender } = render(screenOf());
    await ready();
    rerender(screenOf({ openId: CH2, thread: 7, asked: "1" }));
    await screen.findByRole("complementary", { name: "Thread in #deals" });
    await userEvent.click(screen.getByRole("button", { name: "sales" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    rerender(screenOf({ openId: CH2, thread: 7, asked: "2" }));
    await screen.findByRole("complementary", { name: "Thread in #deals" });
  });
});
