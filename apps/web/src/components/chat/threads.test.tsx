import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatClient,
  type ChatList,
  type ConvRow,
  type MessageView,
  type ThreadPage,
  type ThreadRow,
} from "@/lib/chat/client";
import { isViewing, threadKey } from "@/lib/chat/viewing";
import { ChatScreen } from "./ChatScreen";
import { LeadTeam } from "./LeadTeam";
import { threadsTuning } from "./Threads";

/** Team Chat's threads on the screen (plan 2026-11-25-team-chat-2b, Task 1; canvas board Main). */
type E = {
  c?: string;
  e: string;
  m?: number;
  u?: string;
  t?: number;
  f?: true;
  d?: true;
  l?: true;
  w?: number;
};
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
const phone = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/usePhone", () => ({ usePhone: () => phone.on }));

const id = (n: number) => `0190e0c0-0000-7000-8000-0000000${String(n).padStart(5, "0")}`;
const [ME, SANA, RAHUL, CH, CH2] = [id(1), id(2), id(3), id(50), id(51)] as const;
const people = [
  { id: ME, name: "Maya Kapoor", avatar: null, active: true },
  { id: SANA, name: "Sana Iqbal", avatar: null, active: true },
  { id: RAHUL, name: "Rahul Mehta", avatar: null, active: true },
];
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const bad = (message: string) => ({ ok: false as const, status: 400, code: "NO", message }) as never;
const row = (o: Partial<ConvRow> = {}): ConvRow => ({
  id: CH,
  kind: "channel",
  name: "sales",
  topic: null,
  unread: 0,
  muted: false,
  lastAt: null,
  ...o,
});
const list = (o: Partial<ChatList> = {}): ChatList => ({
  channels: [row(), row({ id: CH2, name: "deals" })],
  direct: [],
  leads: [],
  folds: { channels: false, direct: false, leads: false },
  threads: { any: true, unread: 0 },
  unread: 0,
  ...o,
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
const reply = (n: number, who: string, body: string, o: Partial<MessageView> = {}) =>
  msg(n, who, body, { threadRoot: 1, ...o });
const THREAD = (n = 2) => ({ replies: n, lastAt: new Date().toISOString(), faces: [RAHUL, SANA] });
const thread = (messages: MessageView[], o: Partial<ThreadPage> = {}): ThreadPage => ({
  root: 1,
  conversationId: CH,
  following: true,
  messages,
  members: [],
  more: false,
  lastReadId: 0,
  ...o,
});
const say = (e: E) =>
  act(() => {
    for (const l of stream.chat) l(e);
  });
const show = (l = list()) =>
  render(
    <ChatScreen initial={l} people={people} me={ME} zone="Asia/Kolkata" openId={CH} canManage={false} />,
  );
const pane = () => screen.findByRole("complementary", { name: "Thread in #sales" });
const open = async () => {
  await userEvent.click(await screen.findByRole("button", { name: /^2 replies/ }));
  return pane();
};

beforeEach(() => {
  vi.clearAllMocks();
  phone.on = false;
  for (const f of Object.values(chatClient))
    vi.mocked(f as () => unknown).mockResolvedValue(ok(undefined) as never);
  vi.mocked(chatClient.list).mockResolvedValue(ok(list()));
  vi.mocked(chatClient.online).mockResolvedValue(ok({ online: [] }));
  vi.mocked(chatClient.page).mockResolvedValue(
    ok({
      messages: [msg(1, SANA, "Who takes Thursday?", { thread: THREAD() }), msg(5, ME, "Morning")],
      members: [],
      more: false,
      lastReadId: 5,
    }),
  );
  vi.mocked(chatClient.thread).mockResolvedValue(
    ok(
      thread([
        msg(1, SANA, "Who takes Thursday?", { thread: THREAD() }),
        reply(2, RAHUL, "I can"),
        reply(3, ME, "Thanks"),
      ]),
    ),
  );
  vi.mocked(chatClient.threads).mockResolvedValue(ok({ threads: [] }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a thread beside its conversation", () => {
  it("a message says its replies and when the last came, and opens the thread: the root, a line, the replies", async () => {
    show();
    const link = await screen.findByRole("button", { name: /^2 replies/ });
    expect(link).toHaveTextContent(/^.*2 repliesLast reply \d/);
    const p = await open();
    expect(chatClient.thread).toHaveBeenCalledWith(1, {});
    const log = within(p).getByRole("log");
    await within(log).findByText("I can");
    expect(log.textContent).toMatch(/Who takes Thursday\?.*2 replies.*I can.*Thanks/);
    // Inside, nothing opens a thread of its own.
    expect(within(p).queryByRole("button", { name: "Thread" })).toBeNull();
    // The conversation stays beside it, unchanged.
    expect(screen.getByText("Morning")).toBeInTheDocument();
  });

  it("a message without one starts one from its tools", async () => {
    vi.mocked(chatClient.thread).mockResolvedValue(
      ok(thread([msg(5, ME, "Morning")], { root: 5, following: false, lastReadId: null })),
    );
    show();
    const mine = await screen.findByRole("group", { name: /^Maya Kapoor/ });
    await userEvent.click(within(mine).getByRole("button", { name: "Thread" }));
    const p = await pane();
    expect(chatClient.thread).toHaveBeenCalledWith(5, {});
    await within(p).findByText("Morning");
    expect(within(p).queryByText(/repl(y|ies)$/)).toBeNull();
    expect(within(p).getByRole("button", { name: "Follow" })).toHaveAttribute("aria-pressed", "false");
  });

  it("ready to answer as it opens; Escape closes it and puts the keyboard back where it was opened from", async () => {
    show();
    const link = await screen.findByRole("button", { name: /^2 replies/ });
    const p = await open();
    const box = within(p).getByRole("textbox", { name: "Reply in the thread" });
    expect(box).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).toBeNull();
    await waitFor(() => expect(link).toHaveFocus());
  });

  it("Escape gives up an edit first, and leaves the thread open", async () => {
    show();
    const p = await open();
    await within(p).findByText("Thanks");
    await userEvent.click(within(p).getByRole("button", { name: "Edit" }));
    const box = within(p).getByRole("textbox", { name: "Reply in the thread" });
    expect(box).toHaveValue("Thanks");
    await userEvent.keyboard("{Escape}");
    expect(await pane()).toBeInTheDocument();
    expect(box).toHaveValue("");
  });

  it("a reply goes to the thread alone; also sent only when ticked, and the tick doesn't stay", async () => {
    vi.mocked(chatClient.reply).mockImplementation(async (_r, b) =>
      ok(reply(9, ME, b.body!, { clientId: b.clientId, alsoSent: !!b.alsoSend })),
    );
    show();
    const p = await open();
    const box = within(p).getByRole("textbox", { name: "Reply in the thread" });
    await userEvent.type(box, "Done{Enter}");
    await waitFor(() => expect(chatClient.reply).toHaveBeenCalledTimes(1));
    expect(chatClient.reply).toHaveBeenLastCalledWith(1, { clientId: expect.any(String), body: "Done" });
    expect(chatClient.send).not.toHaveBeenCalled();
    const tick = within(p).getByRole("checkbox", { name: "Also send to #sales" });
    await userEvent.click(tick);
    await userEvent.type(box, "For all{Enter}");
    await waitFor(() => expect(chatClient.reply).toHaveBeenCalledTimes(2));
    expect(vi.mocked(chatClient.reply).mock.lastCall![1]).toMatchObject({ body: "For all", alsoSend: true });
    expect(tick).not.toBeChecked();
    // It is in the conversation at once too, saying where it was said.
    const main = screen.getByRole("log", { name: "Messages" });
    await within(main).findByText("For all");
    expect(within(main).queryByText("Done")).toBeNull();
    expect(within(main).getByRole("button", { name: "Replied in a thread" })).toBeInTheDocument();
  });

  it("a reply that couldn't go waits in its own thread, with why, and goes again from there", async () => {
    vi.mocked(chatClient.reply).mockResolvedValueOnce(bad("Not now."));
    show();
    const p = await open();
    await userEvent.type(within(p).getByRole("textbox", { name: "Reply in the thread" }), "Done{Enter}");
    await within(p).findByText("Not now.");
    const main = screen.getByRole("log", { name: "Messages" });
    expect(within(main).queryByText("Done")).toBeNull();
    vi.mocked(chatClient.reply).mockImplementation(async (_r, b) =>
      ok(reply(9, ME, b.body!, { clientId: b.clientId })),
    );
    await userEvent.click(within(p).getByRole("button", { name: "Couldn't send. Try again" }));
    await waitFor(() => expect(within(p).queryByText("Not now.")).toBeNull());
    expect(within(p).getByText("Done")).toBeInTheDocument();
  });

  it("what is half written in a thread and in its conversation are kept apart", async () => {
    show();
    await userEvent.type(await screen.findByRole("textbox", { name: "Message #sales" }), "For all");
    const p = await open();
    const box = within(p).getByRole("textbox", { name: "Reply in the thread" });
    expect(box).toHaveValue("");
    await userEvent.type(box, "For the thread");
    await userEvent.keyboard("{Escape}");
    await open();
    expect(screen.getByRole("textbox", { name: "Reply in the thread" })).toHaveValue("For the thread");
    expect(screen.getByRole("textbox", { name: "Message #sales" })).toHaveValue("For all");
  });

  it("typing in a thread isn't said in the conversation, nor shown in the thread", async () => {
    show();
    const p = await open();
    await userEvent.type(within(p).getByRole("textbox", { name: "Reply in the thread" }), "Hi");
    expect(chatClient.typing).not.toHaveBeenCalled();
    say({ c: CH, e: "typing", u: SANA });
    expect(within(p).queryByText(/is typing/)).toBeNull();
    expect(screen.getByText("Sana Iqbal is typing…")).toBeInTheDocument();
  });

  it("follow and stop, and put back with why when it couldn't be", async () => {
    show();
    const p = await open();
    const b = await within(p).findByRole("button", { name: "Following" });
    await userEvent.click(b);
    expect(chatClient.followThread).toHaveBeenCalledWith(1, false);
    expect(await within(p).findByRole("button", { name: "Follow" })).toBeInTheDocument();
    vi.mocked(chatClient.followThread).mockResolvedValueOnce(bad("Not now."));
    await userEvent.click(within(p).getByRole("button", { name: "Follow" }));
    await within(p).findByText("Not now.");
    expect(within(p).getByRole("button", { name: "Follow" })).toBeInTheDocument();
  });

  it("no ticks in a thread, in a direct message too", async () => {
    const dm = row({
      id: CH,
      kind: "direct",
      name: null,
      people: [{ id: SANA, name: "Sana Iqbal", avatar: { color: null, version: 0, photo: false } }],
    });
    show(list({ channels: [], direct: [dm] }));
    await userEvent.click(await screen.findByRole("button", { name: /^2 replies/ }));
    const p = await screen.findByRole("complementary", { name: "Thread in Sana Iqbal" });
    await within(p).findByText("Thanks");
    expect(within(p).queryByRole("img", { name: /Sent|Delivered|Seen/ })).toBeNull();
    expect(within(p).getByRole("checkbox", { name: "Also send to the conversation" })).toBeInTheDocument();
  });

  it("opening another conversation closes it", async () => {
    show();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "deals" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("on the lead itself the thread opens over the lead's talk, and Escape closes it alone", async () => {
    vi.mocked(chatClient.leadThread).mockResolvedValue(ok({ id: CH }));
    const outside = vi.fn();
    render(
      <div onKeyDown={outside}>
        <LeadTeam
          lead={{ id: id(90), name: "Asha Rao", stage: null }}
          me={ME}
          zone="Asia/Kolkata"
          people={people.map(({ id: pid, name }) => ({ id: pid, name }))}
        />
      </div>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /^2 replies/ }));
    await screen.findByRole("complementary", { name: "Thread in Asha Rao" });
    outside.mockClear();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(outside).not.toHaveBeenCalled();
  });
});

describe("inside a thread (mutation checks)", () => {
  it("a reply also sent to the conversation opens the thread it was said in", async () => {
    vi.mocked(chatClient.page).mockResolvedValue(
      ok({
        messages: [msg(1, SANA, "Root"), reply(6, RAHUL, "For all", { alsoSent: true })],
        members: [],
        more: false,
        lastReadId: 6,
      }),
    );
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Replied in a thread" }));
    await pane();
    expect(chatClient.thread).toHaveBeenCalledWith(1, {});
  });

  it("its own first message carries no way into a thread, and the count leaves deleted replies out", async () => {
    vi.mocked(chatClient.thread).mockResolvedValue(
      ok(
        thread([
          msg(1, SANA, "Who takes Thursday?", { thread: THREAD() }),
          reply(2, RAHUL, "", { body: null, deletedAt: new Date().toISOString() }),
          reply(3, ME, "Thanks"),
        ]),
      ),
    );
    show();
    const p = await open();
    await within(p).findByText("Thanks");
    expect(within(p).queryByRole("button", { name: /repl(y|ies)/ })).toBeNull();
    expect(within(p).getByText("1 reply")).toBeInTheDocument();
  });

  it("a reply by whoever wrote the first message starts with their name again", async () => {
    vi.mocked(chatClient.thread).mockResolvedValue(
      ok(thread([msg(1, SANA, "Root", { thread: THREAD(1) }), reply(2, SANA, "Me again")])),
    );
    vi.mocked(chatClient.page).mockResolvedValue(
      ok({
        messages: [msg(1, SANA, "Root", { thread: THREAD(1) })],
        members: [],
        more: false,
        lastReadId: 1,
      }),
    );
    show();
    await userEvent.click(await screen.findByRole("button", { name: /^1 reply/ }));
    const p = await pane();
    await within(p).findByText("Me again");
    expect(within(p).getAllByText("Sana Iqbal")).toHaveLength(2);
  });

  it("answering a thread one doesn't follow follows it", async () => {
    vi.mocked(chatClient.thread).mockResolvedValue(
      ok(thread([msg(1, SANA, "Root", { thread: THREAD() })], { following: false, lastReadId: null })),
    );
    vi.mocked(chatClient.reply).mockImplementation(async (_r, b) =>
      ok(reply(9, ME, b.body!, { clientId: b.clientId })),
    );
    show();
    const p = await open();
    await within(p).findByRole("button", { name: "Follow" });
    await userEvent.type(within(p).getByRole("textbox", { name: "Reply in the thread" }), "Me{Enter}");
    expect(await within(p).findByRole("button", { name: "Following" })).toBeInTheDocument();
  });

  it("editing in a thread offers no Also send", async () => {
    show();
    const p = await open();
    await within(p).findByText("Thanks");
    expect(within(p).getByRole("checkbox", { name: "Also send to #sales" })).toBeInTheDocument();
    await userEvent.click(within(p).getByRole("button", { name: "Edit" }));
    expect(within(p).queryByRole("checkbox")).toBeNull();
  });

  it("Escape shuts the mention menu alone: the thread stays open", async () => {
    vi.mocked(chatClient.mentionable).mockResolvedValue(
      ok({ members: [ME, SANA, RAHUL], teams: [], everyone: true }),
    );
    show();
    const p = await open();
    await userEvent.type(within(p).getByRole("textbox", { name: "Reply in the thread" }), "@sa");
    await screen.findByRole("listbox", { name: "Mention someone" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(await pane()).toBeInTheDocument();
  });

  it("another thread opened straight from this one starts clean", async () => {
    vi.mocked(chatClient.page).mockResolvedValue(
      ok({
        messages: [
          msg(1, SANA, "Who takes Thursday?", { thread: THREAD() }),
          msg(5, RAHUL, "Friday?", { thread: THREAD(1) }),
        ],
        members: [],
        more: false,
        lastReadId: 5,
      }),
    );
    show();
    const p = await open();
    await within(p).findByText("I can");
    await userEvent.click(within(p).getAllByRole("button", { name: "Reply" })[0]!);
    expect(within(p).getByText(/^Replying to/)).toBeInTheDocument();
    vi.mocked(chatClient.thread).mockResolvedValue(
      ok(thread([msg(5, RAHUL, "Friday?", { thread: THREAD(1) })], { root: 5 })),
    );
    await userEvent.click(screen.getByRole("button", { name: /^1 reply/ }));
    await waitFor(() => expect(chatClient.thread).toHaveBeenLastCalledWith(5, {}));
    const q = await pane();
    expect(within(q).queryByText(/^Replying to/)).toBeNull();
  });
});

describe("live", () => {
  it("a reply lands in the open thread, and not in the conversation", async () => {
    show();
    const p = await open();
    await within(p).findByText("Thanks");
    vi.mocked(chatClient.thread).mockResolvedValue(ok(thread([reply(8, SANA, "See you there")])));
    vi.mocked(chatClient.page).mockClear();
    say({ c: CH, e: "reply", m: 8, u: SANA, t: 1, f: true });
    await within(p).findByText("See you there", undefined, { timeout: 4000 });
    expect(chatClient.thread).toHaveBeenLastCalledWith(1, { after: 3 });
    // The message it hangs on is read again (one more reply), and nothing newer is asked for.
    expect(vi.mocked(chatClient.page).mock.calls).toEqual([[CH, { after: 0 }]]);
    expect(within(screen.getByRole("log", { name: "Messages" })).queryByText("See you there")).toBeNull();
  });

  it("a reply also sent to the conversation lands in its open thread too", async () => {
    show();
    const p = await open();
    await within(p).findByText("Thanks");
    vi.mocked(chatClient.thread).mockResolvedValue(
      ok(thread([reply(8, SANA, "For all", { alsoSent: true })])),
    );
    say({ c: CH, e: "message", m: 8, u: SANA, t: 1 });
    await within(p).findByText("For all", undefined, { timeout: 4000 });
  });

  it("a reply in another thread of the conversation asks nothing of this one", async () => {
    show();
    const p = await open();
    await within(p).findByText("Thanks");
    vi.mocked(chatClient.thread).mockClear();
    say({ c: CH, e: "reply", m: 8, u: SANA, t: 5 });
    say({ c: CH, e: "message", m: 9, u: SANA });
    await new Promise((r) => setTimeout(r, 1500));
    expect(chatClient.thread).not.toHaveBeenCalled();
  });

  it("what's read in the thread is said of the thread, not of the conversation; their other tabs' is not a tick", async () => {
    show();
    const p = await open();
    await within(p).findByText("Thanks");
    await waitFor(() => expect(chatClient.readThread).toHaveBeenCalledWith(1, 3));
    expect(isViewing(threadKey(1))).toBe(true);
    expect(isViewing(CH)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(isViewing(threadKey(1))).toBe(false);
  });

  it("the Threads row counts what's followed, never one's own, muted, or what's open; a thread read here is asked for", async () => {
    show(list({ threads: { any: true, unread: 1 } }));
    const n = (want: string) =>
      expect(screen.getByRole("button", { name: /^Threads/ })).toHaveTextContent(
        new RegExp(`^Threads${want}$`),
      );
    n("1");
    say({ c: CH2, e: "reply", m: 20, u: SANA, t: 15, f: true });
    n("2");
    say({ c: CH2, e: "reply", m: 21, u: SANA, t: 16 });
    say({ c: CH2, e: "reply", m: 22, u: ME, t: 15, f: true });
    n("2");
    await open();
    say({ c: CH, e: "reply", m: 23, u: SANA, t: 1, f: true });
    n("2");
    vi.mocked(chatClient.list).mockResolvedValue(ok(list({ threads: { any: true, unread: 0 } })));
    say({ c: CH2, e: "read", m: 22, u: ME, t: 15 });
    await waitFor(() => n(""), { timeout: 4000 });
  });

  it("reading a thread in another tab leaves the conversation's own unread alone", async () => {
    show(list({ channels: [row(), row({ id: CH2, name: "deals", unread: 4 })] }));
    say({ c: CH2, e: "read", m: 22, u: ME, t: 15 });
    expect(screen.getByRole("button", { name: /deals/ })).toHaveTextContent("4");
  });

  it("in a muted conversation a followed thread's reply isn't counted", async () => {
    show(list({ channels: [row(), row({ id: CH2, name: "deals", muted: true })] }));
    say({ c: CH2, e: "reply", m: 20, u: SANA, t: 15, f: true });
    expect(screen.getByRole("button", { name: /^Threads/ })).toHaveTextContent(/^Threads$/);
  });
});

describe("where there isn't room for both", () => {
  it("the conversation under the thread is out of reach, and nothing in it is marked read", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    show();
    await screen.findByText("Morning");
    const main = screen.getByRole("region", { name: "#sales" });
    expect(main).not.toHaveAttribute("inert");
    expect(isViewing(CH)).toBe(true);
    await open();
    expect(main).toHaveAttribute("inert");
    expect(isViewing(CH)).toBe(false);
    vi.mocked(chatClient.read).mockClear();
    vi.mocked(chatClient.page).mockResolvedValue(
      ok({ messages: [msg(30, SANA, "Unseen")], members: [], more: false, lastReadId: 5 }),
    );
    say({ c: CH, e: "message", m: 30, u: SANA });
    await screen.findByText("Unseen", undefined, { timeout: 4000 });
    // Longer than a read mark waits.
    await new Promise((r) => setTimeout(r, 3300));
    expect(chatClient.read).not.toHaveBeenCalled();
    // Closed: what's on screen is read.
    await userEvent.keyboard("{Escape}");
    expect(main).not.toHaveAttribute("inert");
    await waitFor(() => expect(chatClient.read).toHaveBeenCalledWith(CH, 30), { timeout: 4000 });
  });
});

describe("the Threads screen", () => {
  const rows: ThreadRow[] = [
    {
      root: msg(1, SANA, "Who takes Thursday?", { thread: THREAD(12) }),
      conversation: row(),
      unread: 3,
    },
    {
      root: msg(7, RAHUL, "", { body: null, deletedAt: new Date().toISOString(), thread: THREAD(1) }),
      conversation: row({ id: CH2, name: "deals" }),
      unread: 0,
    },
  ];
  it("isn't offered to someone who follows none", () => {
    show(list({ threads: { any: false, unread: 0 } }));
    expect(screen.queryByRole("button", { name: /^Threads/ })).toBeNull();
  });

  it("lists them with where they are and what's new, and opens one beside its conversation", async () => {
    vi.mocked(chatClient.threads).mockResolvedValue(ok({ threads: rows }));
    show(list({ threads: { any: true, unread: 3 } }));
    await userEvent.click(screen.getByRole("button", { name: /^Threads/ }));
    const region = await screen.findByRole("region", { name: "The threads you follow" });
    const [first, second] = await within(region).findAllByRole("button");
    expect(first).toHaveTextContent(/Sana Iqbal.*# sales.*Who takes Thursday\?.*12 replies.*3 new/);
    expect(second).toHaveTextContent(/Rahul Mehta.*# deals.*This message was deleted.*1 reply/);
    expect(second).not.toHaveTextContent("new");
    // No conversation is open meanwhile, so none is being read.
    expect(isViewing(CH)).toBe(false);
    await userEvent.click(first!);
    await pane();
    expect(screen.getByRole("textbox", { name: "Message #sales" })).toBeInTheDocument();
  });

  it("says when there are none, and why when it couldn't be read, trying again by itself", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /^Threads/ }));
    await screen.findByText("Nothing here yet. The threads you start or answer are kept here.");
    vi.mocked(chatClient.threads).mockResolvedValueOnce(bad("Not now."));
    say({ c: CH, e: "reply", m: 2, u: SANA, t: 1, f: true });
    threadsTuning.againMs = 300;
    try {
      await screen.findByText("Not now.", undefined, { timeout: 4000 });
      vi.mocked(chatClient.threads).mockResolvedValue(ok({ threads: rows }));
      expect(await screen.findByText("Who takes Thursday?")).toBeInTheDocument();
      expect(screen.queryByText("Not now.")).toBeNull();
    } finally {
      threadsTuning.againMs = 15_000;
    }
  });

  it("another thread's reply in a busy channel isn't asked for; nor is anything while nobody looks", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /^Threads/ }));
    await waitFor(() => expect(chatClient.threads).toHaveBeenCalledTimes(1));
    say({ c: CH, e: "reply", m: 2, u: SANA, t: 1 });
    await new Promise((r) => setTimeout(r, 2600));
    expect(chatClient.threads).toHaveBeenCalledTimes(1);
    const seen = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    say({ c: CH, e: "reply", m: 3, u: SANA, t: 1, f: true });
    await new Promise((r) => setTimeout(r, 2600));
    expect(chatClient.threads).toHaveBeenCalledTimes(1);
    seen.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(chatClient.threads).toHaveBeenCalledTimes(2));
  }, 10_000);

  it("on a phone it opens over the list, and Back returns to it", async () => {
    phone.on = true;
    const { container } = render(
      <ChatScreen initial={list()} people={people} me={ME} zone="Asia/Kolkata" openId={null} />,
    );
    const cx = container.querySelector("[data-full-canvas]")!;
    expect(cx).not.toHaveAttribute("data-open");
    await userEvent.click(screen.getByRole("button", { name: /^Threads/ }));
    expect(cx).toHaveAttribute("data-open");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(cx).not.toHaveAttribute("data-open");
  });
});
