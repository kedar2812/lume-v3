import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatClient, type ChatList, type MessageView } from "@/lib/chat/client";
import { ChatScreen } from "./ChatScreen";
import { LeadTeam } from "./LeadTeam";

/** The Chat screen (plan 2026-11-24-team-chat-2a, Tasks 7 and 8; approved canvas KTQD9PJ… v6). */
const stream = vi.hoisted(() => ({
  chat: new Set<(e: { c?: string; e: string; m?: number; u?: string }) => void>(),
  presence: new Set<(e: { u: string; on: boolean }) => void>(),
}));
vi.mock("@/lib/notifications/stream", () => ({
  subscribeChat: (l: never) => {
    stream.chat.add(l);
    return () => stream.chat.delete(l);
  },
  subscribePresence: (l: never) => {
    stream.presence.add(l);
    return () => stream.presence.delete(l);
  },
}));
vi.mock("@/lib/chat/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/chat/client")>()),
  chatClient: {
    list: vi.fn(),
    mentionable: vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { members: [], teams: [], everyone: true },
    })),
    fold: vi.fn(async () => ({ ok: true, status: 204, data: undefined })),
    mute: vi.fn(async () => ({ ok: true, status: 204, data: undefined })),
    direct: vi.fn(),
    leadThread: vi.fn(),
    page: vi.fn(),
    send: vi.fn(),
    edit: vi.fn(),
    remove: vi.fn(async () => ({ ok: true, status: 204, data: undefined })),
    react: vi.fn(async () => ({ ok: true, status: 204, data: undefined })),
    read: vi.fn(async () => ({ ok: true, status: 204, data: undefined })),
    delivered: vi.fn(async () => ({ ok: true, status: 204, data: undefined })),
    typing: vi.fn(async () => ({ ok: true, status: 204, data: undefined })),
    online: vi.fn(async () => ({ ok: true, status: 200, data: { online: [] } })),
    upload: vi.fn(),
    one: vi.fn(),
    channels: vi.fn(),
    makeChannel: vi.fn(),
    changeChannel: vi.fn(),
    setMembers: vi.fn(),
  },
}));

const ME = "0190e0c0-0000-7000-8000-00000000c001";
const SANA = "0190e0c0-0000-7000-8000-00000000c002";
const RAHUL = "0190e0c0-0000-7000-8000-00000000c003";
const CH = "0190e0c0-0000-7000-8000-00000000c0a1";
const people = [
  { id: ME, name: "Maya Kapoor", avatar: null },
  { id: SANA, name: "Sana Iqbal", avatar: null },
  { id: RAHUL, name: "Rahul Mehta", avatar: null },
];
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const row = (o: Partial<ChatList["channels"][number]>) => ({
  id: CH,
  kind: "channel" as const,
  name: "sales",
  topic: null,
  unread: 0,
  muted: false,
  lastAt: null,
  ...o,
});
const list = (o: Partial<ChatList> = {}): ChatList => ({
  channels: [row({})],
  direct: [],
  leads: [],
  folds: { channels: false, direct: false, leads: false },
  threads: { any: false, unread: 0 },
  unread: 0,
  ...o,
});
const msg = (
  id: number,
  authorId: string | null,
  body: string,
  o: Partial<MessageView> = {},
): MessageView => ({
  id,
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
  createdAt: new Date(Date.UTC(2026, 10, 24, 10, id)).toISOString(),
  ...o,
});
const say = (e: { c?: string; e: string; m?: number; u?: string }) =>
  act(() => {
    for (const l of stream.chat) l(e);
  });
const open = (l = list()) =>
  render(<ChatScreen initial={l} people={people} me={ME} zone="Asia/Kolkata" openId={CH} />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chatClient.list).mockResolvedValue(ok(list()));
  vi.mocked(chatClient.page).mockResolvedValue(
    ok({
      messages: [msg(1, SANA, "Did Meera send it?"), msg(2, SANA, "The measurements"), msg(3, ME, "Not yet")],
      members: [],
      more: false,
      lastReadId: 0,
    }),
  );
});
afterEach(() => vi.useRealTimers());

describe("the list", () => {
  it("a folded list says the sum of its unread, 99+ past 99, and the fold is kept", async () => {
    const other = (n: number, i: number) =>
      row({ id: `0190e0c0-0000-7000-8000-0000000000${10 + i}`, name: `c${i}`, unread: n });
    open(list({ channels: [row({}), other(60, 1), other(45, 2)] }));
    const heading = screen.getByRole("button", { name: /^Channels/ });
    expect(heading).toHaveAttribute("aria-expanded", "true");
    expect(within(heading).queryByText("99+")).toBeNull();
    await userEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(within(heading).getByText("99+")).toBeInTheDocument();
    expect(chatClient.fold).toHaveBeenCalledWith("channels", true);
  });

  it("a folded list with nothing unread shows no bubble; the open conversation's count is being read", async () => {
    open(list({ channels: [row({ unread: 4 })], folds: { channels: true, direct: false, leads: false } }));
    expect(within(screen.getByRole("button", { name: /^Channels/ })).queryByText("4")).toBeNull();
  });
});

describe("the conversation", () => {
  it("my messages on the right, others on the left, each run on its sender's photo", async () => {
    open();
    const mine = await screen.findByText("Not yet");
    const theirs = screen.getByText("The measurements");
    const bubble = (el: HTMLElement) => el.closest("[data-side]")!;
    expect(bubble(mine)).toHaveAttribute("data-side", "mine");
    expect(bubble(theirs)).toHaveAttribute("data-side", "in");
    // Sana's two are one run: the first carries her photo, the second sits under it.
    expect(bubble(screen.getByText("Did Meera send it?"))).toHaveAttribute("data-head");
    expect(bubble(theirs)).not.toHaveAttribute("data-head");
    expect(
      within(bubble(screen.getByText("Did Meera send it?")) as HTMLElement).getByRole("img", {
        name: "Sana Iqbal",
      }),
    ).toBeInTheDocument();
    // In a channel, the name goes on the run's first bubble.
    expect(
      within(bubble(screen.getByText("Did Meera send it?")) as HTMLElement).getByText("Sana Iqbal"),
    ).toBeInTheDocument();
    expect(chatClient.read).toHaveBeenCalledWith(CH, 3);
  });

  it("a message from the stream lands once, in order, even if it's said twice", async () => {
    open();
    await screen.findByText("Not yet");
    vi.mocked(chatClient.page).mockResolvedValue(
      ok({ messages: [msg(4, RAHUL, "Booked!")], members: [], more: false, lastReadId: 0 }),
    );
    say({ c: CH, e: "message", m: 4, u: RAHUL });
    say({ c: CH, e: "message", m: 4, u: RAHUL });
    await waitFor(() => expect(screen.getAllByText("Booked!")).toHaveLength(1));
    const texts = screen.getAllByRole("group").map((g) => g.textContent);
    expect(texts.findIndex((t) => t?.includes("Booked!"))).toBeGreaterThan(
      texts.findIndex((t) => t?.includes("Not yet")),
    );
  });

  it("typing shows the name, and goes 5 s after the last", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open();
    await screen.findByText("Not yet");
    say({ c: CH, e: "typing", u: SANA });
    expect(screen.getByText("Sana Iqbal is typing…")).toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(5100));
    expect(screen.queryByText("Sana Iqbal is typing…")).toBeNull();
  });

  it("a deleted message changes in place to say so", async () => {
    open();
    await screen.findByText("The measurements");
    vi.mocked(chatClient.page).mockResolvedValue(
      ok({
        messages: [msg(2, SANA, "", { body: null, deletedAt: new Date().toISOString() })],
        members: [],
        more: false,
        lastReadId: 0,
      }),
    );
    say({ c: CH, e: "deleted", m: 2 });
    expect(await screen.findByText("This message was deleted")).toBeInTheDocument();
    expect(screen.queryByText("The measurements")).toBeNull();
  });

  it("Enter sends, Shift+Enter doesn't; a send that fails stays with a way to try again", async () => {
    vi.mocked(chatClient.send).mockResolvedValueOnce({
      ok: false,
      status: 503,
      code: "OFFLINE",
      message: "LUME can't reach the server right now.",
    } as never);
    open();
    await screen.findByText("Not yet");
    const box = screen.getByRole("textbox", { name: "Message #sales" });
    await userEvent.type(box, "Line one{Shift>}{Enter}{/Shift}line two");
    expect(chatClient.send).not.toHaveBeenCalled();
    await userEvent.type(box, "{Enter}");
    expect(chatClient.send).toHaveBeenCalledWith(CH, expect.objectContaining({ body: "Line one\nline two" }));
    const retry = await screen.findByRole("button", { name: "Couldn't send. Try again" });
    vi.mocked(chatClient.send).mockResolvedValueOnce(ok(msg(9, ME, "Line one\nline two")) as never);
    const first = vi.mocked(chatClient.send).mock.calls[0]![1].clientId;
    await userEvent.click(retry);
    // The same send again: the same clientId, so it can only ever land once.
    expect(vi.mocked(chatClient.send).mock.calls[1]![1].clientId).toBe(first);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Couldn't send. Try again" })).toBeNull(),
    );
  });

  it("ticks in a direct message: Seen once the other person has read it", async () => {
    const dm = row({
      id: CH,
      kind: "direct",
      name: null,
      people: [{ id: SANA, name: "Sana Iqbal", avatar: { color: null, version: 0, photo: false } }],
    });
    vi.mocked(chatClient.page).mockResolvedValue(
      ok({
        messages: [msg(3, ME, "Not yet")],
        members: [{ userId: SANA, lastReadId: 0, lastDeliveredId: 0 }],
        more: false,
        lastReadId: 3,
      }),
    );
    open(list({ channels: [], direct: [dm] }));
    expect(await screen.findByRole("img", { name: "Sent" })).toBeInTheDocument();
    say({ c: CH, e: "delivered", m: 3, u: SANA });
    expect(await screen.findByRole("img", { name: "Delivered" })).toBeInTheDocument();
    say({ c: CH, e: "read", m: 3, u: SANA });
    expect(await screen.findByRole("img", { name: "Seen" })).toBeInTheDocument();
  });
});

describe("a lead's Team tab", () => {
  it("opens the lead's thread, and says who can read it", async () => {
    vi.mocked(chatClient.leadThread).mockResolvedValue(ok({ id: CH }));
    vi.mocked(chatClient.page).mockResolvedValue(
      ok({ messages: [], members: [], more: false, lastReadId: 0 }),
    );
    render(
      <LeadTeam
        lead={{ id: "0190e0c0-0000-7000-8000-00000000d001", name: "Priya Shah", stage: null }}
        me={ME}
        zone="Asia/Kolkata"
        people={people.map((p) => ({ id: p.id, name: p.name }))}
      />,
    );
    expect(
      await screen.findByText("Only people who can see Priya's lead read this. Priya never does."),
    ).toBeInTheDocument();
    expect(chatClient.leadThread).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Message Priya Shah" }), {
      target: { value: "Booked" },
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});
