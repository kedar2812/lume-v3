import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatClient,
  type ChatList,
  type ConvRow,
  type MessagePage,
  type MessageView,
} from "@/lib/chat/client";
import { onMuted } from "@/lib/chat/viewing";
import { ChatScreen } from "./ChatScreen";
import { LeadTeam } from "./LeadTeam";
import { CATCH_UP_MS, READ_MS } from "./useMessages";

/** Team Chat's first review (2026-11-24): each finding on the screen, held by a test. */
type E = { c?: string; e: string; m?: number; u?: string; d?: true; l?: true; w?: number };
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
  { id: id(4), name: "Old Person", avatar: null, active: false },
];
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const bad = (message: string) => ({ ok: false as const, status: 400, code: "NO", message }) as never;
const row = (o: Partial<ConvRow>): ConvRow => ({
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
  channels: [row({}), row({ id: CH2, name: "deals" })],
  direct: [],
  leads: [],
  folds: { channels: false, direct: false, leads: false },
  threads: { any: false, unread: 0 },
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
  createdAt: new Date(Date.UTC(2026, 10, 24, 10, 0, n)).toISOString(),
  ...o,
});
const page = (messages: MessageView[], o: Partial<MessagePage> = {}): MessagePage => ({
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
const show = (o: { openId?: string | null; l?: ChatList; canManage?: boolean } = {}) =>
  render(
    <ChatScreen
      initial={o.l ?? list()}
      people={people}
      me={ME}
      zone="Asia/Kolkata"
      openId={o.openId === undefined ? CH : o.openId}
      canManage={o.canManage ?? false}
    />,
  );
const box = (name = "Message #sales") => screen.findByRole("textbox", { name });

beforeEach(() => {
  vi.clearAllMocks();
  phone.on = false;
  for (const f of Object.values(chatClient))
    vi.mocked(f as () => unknown).mockResolvedValue(ok(undefined) as never);
  vi.mocked(chatClient.list).mockResolvedValue(ok(list()));
  vi.mocked(chatClient.online).mockResolvedValue(ok({ online: [] }));
  vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(1, SANA, "Morning"), msg(2, ME, "Hello")])));
});
afterEach(() => {
  // Closed while the API still answers: closing says what was read.
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("a conversation nothing happens in draws nothing again, however long drawing takes", async () => {
  // Each look at the clock is a moment later, as on a slow machine.
  let t = Date.UTC(2026, 10, 24, 11);
  const clock = vi.spyOn(Date, "now").mockImplementation(() => (t += 7));
  show();
  await screen.findByText("Morning");
  say({ c: CH, e: "typing", u: SANA });
  await screen.findByText("Sana Iqbal is typing…");
  const before = clock.mock.calls.length;
  await new Promise((r) => setTimeout(r, 300));
  expect(clock.mock.calls.length - before).toBeLessThan(30);
});

describe("writing", () => {
  it("editing a message and giving up, or saving it, brings back what was being written", async () => {
    show();
    const b = await box();
    await userEvent.type(b, "Half a thought");
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(b).toHaveValue("Hello");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(b).toHaveValue("Half a thought");
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.type(b, " there");
    vi.mocked(chatClient.edit).mockResolvedValueOnce(bad("That message isn't there."));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    // Not saved: the words stay, and why is said.
    expect(await screen.findByText("That message isn't there.")).toBeInTheDocument();
    expect(b).toHaveValue("Hello there");
    vi.mocked(chatClient.edit).mockResolvedValueOnce(ok(msg(2, ME, "Hello there")));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(b).toHaveValue("Half a thought"));
    expect(chatClient.edit).toHaveBeenCalledTimes(2);
    expect(chatClient.send).not.toHaveBeenCalled();
    await userEvent.clear(b);
  });

  it("what was being written waits while another conversation is open", async () => {
    show();
    await userEvent.type(await box(), "For sales");
    await userEvent.click(screen.getByRole("button", { name: /deals/ }));
    expect(await box("Message #deals")).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: /sales/ }));
    const b = await box();
    expect(b).toHaveValue("For sales");
    await userEvent.clear(b);
  });

  it("sends go one after another, each shown once; one that failed waits while away, and can be discarded", async () => {
    let first!: (r: unknown) => void;
    vi.mocked(chatClient.send).mockImplementationOnce(
      () => new Promise((r) => (first = r as never)) as never,
    );
    show();
    const b = await box();
    await userEvent.type(b, "One{Enter}");
    await userEvent.type(b, "Two{Enter}");
    expect(chatClient.send).toHaveBeenCalledTimes(1);
    const c1 = vi.mocked(chatClient.send).mock.calls[0]![1].clientId;
    // The stream brings it before the answer does: still shown once.
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(3, ME, "One", { clientId: c1 })])));
    say({ c: CH, e: "message", m: 3, u: ME });
    await waitFor(() => expect(chatClient.page).toHaveBeenCalledWith(CH, { after: 2 }));
    expect(screen.getAllByText("One")).toHaveLength(1);
    vi.mocked(chatClient.send).mockResolvedValueOnce(bad("LUME can't reach the server right now."));
    await act(async () => first(ok(msg(3, ME, "One", { clientId: c1 }))));
    await waitFor(() => expect(chatClient.send).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Couldn't send. Try again" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /deals/ }));
    await box("Message #deals");
    expect(screen.queryByText("Two")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /sales/ }));
    expect(await screen.findByText("Two")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("Two")).toBeNull();
  });

  it("photos pasted go up with the message, up to as many as one can carry", async () => {
    let n = 0;
    vi.mocked(chatClient.upload).mockImplementation(async (f) =>
      ok({
        file: {
          id: id(900 + n++),
          name: f.name,
          mime: "image/png",
          kind: "image",
          size: 3,
          url: "/x",
        } as never,
      }),
    );
    show();
    const b = await box();
    const many = Array.from({ length: 12 }, (_, i) => new File(["abc"], `p${i}.png`, { type: "image/png" }));
    fireEvent.paste(b, { clipboardData: { files: many } });
    expect(await screen.findByText(/A message can carry at most \d+ files\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Uploading…")).toBeNull());
    const kept = vi.mocked(chatClient.upload).mock.calls.length;
    expect(kept).toBeLessThan(12);
    for (const x of screen.getAllByRole("button", { name: /^Take off/ })) await userEvent.click(x);
  });

  it("deleting asks once more", async () => {
    show();
    await screen.findByText("Hello");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(chatClient.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete for everyone?" }));
    expect(chatClient.remove).toHaveBeenCalledWith(2);
  });
});

describe("what's on screen", () => {
  // 2B Task 7 (pending list 2026-11-28): a photo shows as its thumbnail, and opens whole.
  it("a photo in a message shows its thumbnail, and opens the photo itself", async () => {
    vi.mocked(chatClient.page).mockResolvedValue(
      ok(
        page([
          msg(70, SANA, "", {
            body: null,
            files: [
              {
                id: "f1",
                name: "studio.png",
                mime: "image/png",
                kind: "image",
                size: 3,
                url: "/api/v1/chat/files/f1",
              },
            ],
          } as never),
        ]),
      ),
    );
    show();
    const img = await screen.findByAltText("studio.png");
    expect(img).toHaveAttribute("src", "/api/v1/chat/files/f1/thumb");
    expect(img.closest("a")).toHaveAttribute("href", "/api/v1/chat/files/f1");
  });

  it("a message not loaded that changes isn't put in, out of place; one quoted loses its words when deleted", async () => {
    vi.mocked(chatClient.page).mockResolvedValue(
      ok(
        page([msg(60, SANA, "Quoting", { replyTo: { id: 5, authorId: RAHUL, body: "Secret words" } })], {
          more: true,
        }),
      ),
    );
    show();
    expect(await screen.findByText("Secret words")).toBeInTheDocument();
    const calls = vi.mocked(chatClient.page).mock.calls.length;
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(5, RAHUL, "Out of place")])));
    say({ c: CH, e: "reaction", m: 5 });
    say({ c: CH, e: "deleted", m: 5 });
    await waitFor(() => expect(screen.queryByText("Secret words")).toBeNull());
    expect(screen.getByText("This message was deleted")).toBeInTheDocument();
    expect(vi.mocked(chatClient.page).mock.calls.length).toBe(calls);
    expect(screen.queryByText("Out of place")).toBeNull();
  });

  it("replying to a message that's then deleted stops", async () => {
    show();
    await screen.findByText("Morning");
    await userEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]!);
    expect(screen.getByText(/Replying to Sana Iqbal/)).toBeInTheDocument();
    say({ c: CH, e: "deleted", m: 1 });
    expect(screen.queryByText(/Replying to/)).toBeNull();
  });

  it("earlier messages come above, page by page, until there are none", async () => {
    vi.mocked(chatClient.page).mockImplementation(async (_c, q) =>
      ok(q?.before ? page([msg(7, SANA, "Older")]) : page([msg(60, SANA, "Newest")], { more: true })),
    );
    show();
    await screen.findByText("Newest");
    await userEvent.click(screen.getByRole("button", { name: "Earlier messages" }));
    expect(await screen.findByText("Older")).toBeInTheDocument();
    expect(chatClient.page).toHaveBeenLastCalledWith(CH, { before: 60 });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Earlier messages" })).toBeNull());
  });

  it("more than a page missed is all fetched, and back after a long while the newest is shown afresh", async () => {
    show();
    await screen.findByText("Hello");
    vi.mocked(chatClient.page).mockImplementation(async (_c, q) =>
      ok(
        q?.after === 2
          ? page([msg(3, SANA, "Third")], { more: true })
          : q?.after === 3
            ? page([msg(4, SANA, "Fourth")])
            : page([msg(90, SANA, "Much later")], { more: true }),
      ),
    );
    say({ c: CH, e: "message", m: 4, u: SANA });
    expect(await screen.findByText("Fourth")).toBeInTheDocument();
    expect(screen.getByText("Third")).toBeInTheDocument();
    say({ c: "*", e: "reconnected" });
    expect(await screen.findByText("Much later")).toBeInTheDocument();
    // No hole: what doesn't join up isn't shown beside it.
    expect(screen.queryByText("Fourth")).toBeNull();
    expect(screen.getByRole("button", { name: "Earlier messages" })).toBeInTheDocument();
  });

  it("unread starts after where I had read; further up, there's a way to it", async () => {
    vi.mocked(chatClient.page).mockImplementation(async (_c, q) =>
      ok(
        q?.before
          ? page([msg(10, SANA, "Read before"), msg(20, SANA, "First unread")])
          : page([msg(60, SANA, "Newest")], { more: true, lastReadId: 10 }),
      ),
    );
    Element.prototype.scrollIntoView = vi.fn();
    show();
    await screen.findByText("Newest");
    expect(screen.queryByText("New")).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Jump to first unread" }));
    const line = await screen.findByText("New");
    const after = line.compareDocumentPosition(screen.getByText("First unread"));
    expect(after & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const before = line.compareDocumentPosition(screen.getByText("Read before"));
    expect(before & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("read only in a tab being looked at, and once it is", async () => {
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    show();
    await screen.findByText("Hello");
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(chatClient.read).not.toHaveBeenCalled();
    vis.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(chatClient.read).toHaveBeenCalledWith(CH, 2);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(chatClient.read).toHaveBeenCalledTimes(1);
  });

  it("a message that lands while the first page is on its way is there", async () => {
    let first!: (r: unknown) => void;
    vi.mocked(chatClient.page).mockImplementationOnce(
      () => new Promise((r) => (first = r as never)) as never,
    );
    vi.mocked(chatClient.page).mockImplementation(async (_c, q) =>
      ok(page(q?.after === 1 ? [msg(2, SANA, "Just now")] : [])),
    );
    show();
    await act(async () => undefined);
    say({ c: CH, e: "message", m: 2, u: SANA });
    // The page read before it was said arrives without it.
    await act(async () => first(ok(page([msg(1, SANA, "Morning")]))));
    expect(await screen.findByText("Just now")).toBeInTheDocument();
    expect(screen.getAllByText("Morning")).toHaveLength(1);
  });

  it("an older page that arrives after the newest was shown afresh isn't put beside it", async () => {
    let older!: (r: unknown) => void;
    vi.mocked(chatClient.page).mockResolvedValueOnce(ok(page([msg(60, SANA, "Sixty")], { more: true })));
    show();
    await screen.findByText("Sixty");
    vi.mocked(chatClient.page).mockImplementationOnce(
      () => new Promise((r) => (older = r as never)) as never,
    );
    await userEvent.click(screen.getByRole("button", { name: "Earlier messages" }));
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(200, SANA, "Two hundred")], { more: true })));
    say({ c: "*", e: "reconnected" });
    await screen.findByText("Two hundred");
    await act(async () => older(ok(page([msg(50, SANA, "Fifty")]))));
    expect(screen.queryByText("Fifty")).toBeNull();
    expect(screen.getByRole("button", { name: "Earlier messages" })).toBeInTheDocument();
  });

  it("someone reading up the conversation hasn't read what lands below", async () => {
    show();
    await screen.findByText("Hello");
    const log = screen.getByRole("log");
    Object.defineProperties(log, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 400, configurable: true },
    });
    log.scrollTop = 500;
    log.dispatchEvent(new Event("scroll"));
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(3, SANA, "Below")])));
    say({ c: CH, e: "message", m: 3, u: SANA });
    await screen.findByText("Below");
    expect(chatClient.read).not.toHaveBeenCalledWith(CH, 3);
    log.scrollTop = 1600;
    act(() => void log.dispatchEvent(new Event("scroll")));
    await waitFor(() => expect(chatClient.read).toHaveBeenCalledWith(CH, 3), { timeout: READ_MS + 1000 });
  });

  it("typing stops as their message lands", async () => {
    show();
    await screen.findByText("Hello");
    say({ c: CH, e: "typing", u: SANA });
    expect(screen.getByText("Sana Iqbal is typing…")).toBeInTheDocument();
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(3, SANA, "Sent it")])));
    say({ c: CH, e: "message", m: 3, u: SANA });
    await screen.findByText("Sent it");
    expect(screen.queryByText(/is typing/)).toBeNull();
  });
});

describe("a busy channel costs little", () => {
  const unread = () =>
    within(screen.getByRole("button", { name: /deals/ })).queryByText(/^\d+\+?$/)?.textContent;

  it("messages pouring in: one read a second, a read mark every few, and the list counts them itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    await screen.findByText("Hello");
    vi.mocked(chatClient.page).mockClear();
    vi.mocked(chatClient.read).mockClear();
    let last = 2;
    vi.mocked(chatClient.page).mockImplementation(async (_c, q) =>
      ok(page([msg(last, SANA, `m${last}`)].filter((m) => m.id > (q?.after ?? 0)))),
    );
    for (let i = 0; i < 50; i++) {
      last = 3 + i;
      say({ c: CH, e: "message", m: last, u: SANA });
      say({ c: CH2, e: "message", m: 1000 + i, u: SANA });
      await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    }
    await act(async () => void (await vi.advanceTimersByTimeAsync(CATCH_UP_MS)));
    expect(screen.getByText("m52")).toBeInTheDocument();
    // Ten seconds of five a second in each.
    expect(vi.mocked(chatClient.page).mock.calls.length).toBeLessThanOrEqual(13);
    expect(vi.mocked(chatClient.read).mock.calls.length).toBeLessThanOrEqual(5);
    expect(chatClient.list).not.toHaveBeenCalled();
    expect(chatClient.delivered).not.toHaveBeenCalled();
    expect(unread()).toBe("50");
    // Every one ends up read.
    await act(async () => void (await vi.advanceTimersByTimeAsync(READ_MS)));
    expect(chatClient.read).toHaveBeenLastCalledWith(CH, 52);
    vi.useRealTimers();
  });

  it("with many listening, reads are further apart still", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    await screen.findByText("Hello");
    vi.mocked(chatClient.page).mockClear();
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([])));
    for (let i = 0; i < 40; i++) {
      say({ c: CH, e: "message", m: 10 + i, u: SANA, w: 4000 });
      await act(async () => void (await vi.advanceTimersByTimeAsync(500)));
    }
    expect(vi.mocked(chatClient.page).mock.calls.length).toBeLessThanOrEqual(6);
    vi.useRealTimers();
  });

  it("a tab nobody is looking at reads nothing, and catches up when it is", async () => {
    show();
    await screen.findByText("Hello");
    vi.mocked(chatClient.page).mockClear();
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(3, SANA, "While away")])));
    say({ c: CH, e: "message", m: 3, u: SANA });
    say({ c: CH, e: "reaction", m: 1 });
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    expect(chatClient.page).not.toHaveBeenCalled();
    vis.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(await screen.findByText("While away")).toBeInTheDocument();
  });

  it("a message elsewhere counts here; one's own, read in another tab, doesn't; a new conversation asks", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    await screen.findByText("Hello");
    say({ c: CH2, e: "message", m: 90, u: SANA });
    expect(unread()).toBe("1");
    say({ c: CH2, e: "read", m: 90, u: SANA });
    expect(unread()).toBe("1");
    say({ c: CH2, e: "read", m: 90, u: ME });
    expect(unread()).toBeUndefined();
    say({ c: CH2, e: "message", m: 91, u: SANA });
    say({ c: CH2, e: "message", m: 92, u: ME });
    expect(unread()).toBeUndefined();
    expect(chatClient.list).not.toHaveBeenCalled();
    say({ c: id(400), e: "message", m: 93, u: SANA });
    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    expect(chatClient.list).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("Delivered is said of direct messages alone: as they land, and those that landed while away", async () => {
    const dm = row({ id: id(60), kind: "direct", name: null, people: [], unread: 2 });
    show({ l: list({ direct: [dm] }) });
    await screen.findByText("Hello");
    expect(chatClient.delivered).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chatClient.delivered).mock.calls[0]![0]).toBe(id(60));
    // Read from the server again, nothing newer there: not said again.
    vi.mocked(chatClient.list).mockResolvedValue(ok(list({ direct: [dm] })));
    say({ c: "*", e: "reconnected" });
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    expect(chatClient.list).toHaveBeenCalled();
    expect(chatClient.delivered).toHaveBeenCalledTimes(1);
    say({ c: id(60), e: "message", m: 70, u: SANA, d: true });
    expect(chatClient.delivered).toHaveBeenLastCalledWith(id(60), 70);
    say({ c: id(60), e: "message", m: 71, u: ME, d: true });
    say({ c: CH2, e: "message", m: 72, u: SANA });
    expect(chatClient.delivered).toHaveBeenCalledTimes(2);
  });

  it("who's online is asked again after the stream was away", async () => {
    show();
    await screen.findByText("Hello");
    expect(chatClient.online).toHaveBeenCalledTimes(1);
    say({ c: "*", e: "reconnected" });
    expect(chatClient.online).toHaveBeenCalledTimes(2);
  });
});

describe("a conversation that couldn't load", () => {
  it("tries again by itself; a message sent meanwhile waits for it, and history has no hole", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(chatClient.page).mockResolvedValue(bad("LUME can't reach the server right now."));
    show();
    expect(await screen.findByText("LUME can't reach the server right now.")).toBeInTheDocument();
    vi.mocked(chatClient.send).mockImplementation(async (_c, b) =>
      ok(msg(900, ME, b.body ?? "", { clientId: b.clientId })),
    );
    await userEvent.type(await box(), "Anyone?{Enter}");
    // Nothing is asked for from the beginning of time.
    for (const [, q] of vi.mocked(chatClient.page).mock.calls) expect(q).toBeUndefined();
    vi.mocked(chatClient.page).mockImplementation(async (_c, q) =>
      ok(
        q?.after !== undefined
          ? page([])
          : page([msg(899, SANA, "Before"), msg(900, ME, "Anyone?")], { more: true }),
      ),
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getAllByText("Anyone?")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Earlier messages" })).toBeInTheDocument();
    expect(screen.queryByText("LUME can't reach the server right now.")).toBeNull();
    vi.useRealTimers();
  });

  it("a catch-up that failed is tried again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    await screen.findByText("Hello");
    vi.mocked(chatClient.page).mockResolvedValueOnce(bad("down"));
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(3, SANA, "Third time")])));
    say({ c: CH, e: "message", m: 3, u: SANA });
    await act(async () => void (await vi.advanceTimersByTimeAsync(6000)));
    expect(screen.getByText("Third time")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("leaving says what was seen and not yet said", async () => {
    show();
    await screen.findByText("Hello");
    await waitFor(() => expect(chatClient.read).toHaveBeenCalledWith(CH, 2));
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(3, SANA, "Just in")])));
    say({ c: CH, e: "message", m: 3, u: SANA });
    await screen.findByText("Just in");
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(chatClient.read).not.toHaveBeenCalledWith(CH, 3);
    await userEvent.click(screen.getByRole("button", { name: /deals/ }));
    expect(chatClient.read).toHaveBeenCalledWith(CH, 3);
  });

  it("the list that couldn't be read is read again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    await screen.findByText("Hello");
    vi.mocked(chatClient.list).mockResolvedValueOnce(bad("down"));
    vi.mocked(chatClient.list).mockResolvedValue(
      ok(list({ channels: [row({}), row({ id: CH2, name: "renamed" })] })),
    );
    say({ e: "members" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(35_000)));
    expect(screen.getByRole("button", { name: /renamed/ })).toBeInTheDocument();
  });

  it("Try again pressed twice sends once", async () => {
    vi.mocked(chatClient.send).mockResolvedValueOnce(bad("down"));
    show();
    await userEvent.type(await box(), "Once{Enter}");
    const again = await screen.findByRole("button", { name: "Couldn't send. Try again" });
    let answer!: (r: unknown) => void;
    vi.mocked(chatClient.send).mockImplementation(() => new Promise((r) => (answer = r as never)) as never);
    act(() => {
      again.click();
      again.click();
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    await act(async () => answer(ok(msg(3, ME, "Once"))));
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(chatClient.send).toHaveBeenCalledTimes(2);
  });

  it("a read mark that couldn't be said is said later", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(chatClient.read).mockResolvedValueOnce(bad("down"));
    show();
    await screen.findByText("Hello");
    await waitFor(() => expect(chatClient.read).toHaveBeenCalledTimes(1));
    await act(async () => void (await vi.advanceTimersByTimeAsync(11_000)));
    expect(chatClient.read).toHaveBeenCalledTimes(2);
    expect(chatClient.read).toHaveBeenLastCalledWith(CH, 2);
    vi.useRealTimers();
  });

  it("away, then back: a message further up that was deleted meanwhile loses its words", async () => {
    vi.mocked(chatClient.page).mockImplementation(async (_c, q) =>
      ok(q?.before ? page([msg(10, SANA, "Regret")]) : page([msg(60, SANA, "Newest")], { more: true })),
    );
    show();
    await screen.findByText("Newest");
    await userEvent.click(screen.getByRole("button", { name: "Earlier messages" }));
    await screen.findByText("Regret");
    vi.mocked(chatClient.page).mockImplementation(async (_c, q) =>
      ok(
        q?.after === 9
          ? page([msg(10, SANA, "", { body: null, deletedAt: new Date().toISOString() })])
          : q?.after !== undefined
            ? page([])
            : page([msg(60, SANA, "Newest")], { more: true }),
      ),
    );
    say({ c: "*", e: "reconnected" });
    await waitFor(() => expect(screen.queryByText("Regret")).toBeNull());
    expect(screen.getByText("This message was deleted")).toBeInTheDocument();
  });

  it("a send refused for good says why", async () => {
    vi.mocked(chatClient.send).mockResolvedValueOnce(bad("That message can't be replied to."));
    show();
    await userEvent.type(await box(), "Re{Enter}");
    expect(await screen.findByText("That message can't be replied to.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  });

  it("a file still going up as another conversation is opened waits with what was being written", async () => {
    let done!: (r: unknown) => void;
    vi.mocked(chatClient.upload).mockImplementationOnce(
      () => new Promise((r) => (done = r as never)) as never,
    );
    show();
    fireEvent.paste(await box(), {
      clipboardData: { files: [new File(["x"], "plan.png", { type: "image/png" })] },
    });
    await userEvent.click(screen.getByRole("button", { name: /deals/ }));
    await box("Message #deals");
    await act(async () =>
      done(
        ok({ file: { id: id(950), name: "plan.png", mime: "image/png", kind: "image", size: 1, url: "/x" } }),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /sales/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Take off plan.png" }));
  });
});

describe("no hole, and nothing left as it was (review 3)", () => {
  /** A server with every message from 1 to `last`, in pages of 50 as it gives them. */
  const server = (o: { last: number; own?: Record<number, Partial<MessageView>> }) =>
    vi.mocked(chatClient.page).mockImplementation(async (_c, q) => {
      const all = Array.from({ length: o.last }, (_, i) =>
        msg(i + 1, SANA, `n${i + 1}.`, o.own?.[i + 1] ?? {}),
      );
      const got =
        q?.after !== undefined
          ? all.filter((m) => m.id > q.after!)
          : all.filter((m) => m.id < (q?.before ?? Infinity));
      const rows = q?.after !== undefined ? got.slice(0, 50) : got.slice(-50);
      return ok(page(rows, { more: got.length > 50, lastReadId: o.last }));
    });
  const shownIds = () =>
    screen.queryAllByText(/^n\d+\.$/).map((e) => Number(/\d+/.exec(e.textContent ?? "")![0]));
  const whole = () => {
    const ids = shownIds();
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => ids[0]! + i));
    return ids;
  };

  it("hundreds missed, and a send in the middle of catching up: no hole between", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const o = { last: 10, own: {} as Record<number, Partial<MessageView>> };
    server(o);
    show();
    await screen.findByText("n10.");
    o.last = 900;
    vi.mocked(chatClient.send).mockImplementation(async (_c, b) => {
      o.last = 901;
      o.own[901] = { authorId: ME, clientId: b.clientId };
      return ok(msg(901, ME, "n901.", { clientId: b.clientId }));
    });
    say({ c: CH, e: "message", m: 900, u: SANA });
    await userEvent.type(await box(), "x{Enter}");
    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    const ids = whole();
    expect(ids.at(-1)).toBe(901);
    vi.useRealTimers();
  });

  it("back from a drop while catching up: no hole between", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const o = { last: 10 };
    server(o);
    show();
    await screen.findByText("n10.");
    o.last = 700;
    say({ c: CH, e: "message", m: 700, u: SANA });
    say({ c: "*", e: "reconnected" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    say({ c: "*", e: "reconnected" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    expect(whole().at(-1)).toBe(700);
    vi.useRealTimers();
  });

  it("a message deleted while the page it's in is on its way loses its words", async () => {
    let first!: (r: unknown) => void;
    vi.mocked(chatClient.page).mockImplementationOnce(
      () => new Promise((r) => (first = r as never)) as never,
    );
    const gone = msg(1, SANA, "", { body: null, deletedAt: new Date().toISOString() });
    // The quote itself is further on than what's read again.
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([gone])));
    show();
    await act(async () => undefined);
    say({ c: CH, e: "deleted", m: 1 });
    await act(async () =>
      first(
        ok(
          page([
            msg(1, SANA, "Regret"),
            msg(2, SANA, "Quoting it", { replyTo: { id: 1, authorId: SANA, body: "Regret" } }),
          ]),
        ),
      ),
    );
    await waitFor(() => expect(screen.queryByText("Regret")).toBeNull());
    expect(screen.getAllByText("This message was deleted").length).toBeGreaterThan(0);
  });

  it("the same for an older page", async () => {
    let older!: (r: unknown) => void;
    vi.mocked(chatClient.page).mockResolvedValueOnce(ok(page([msg(60, SANA, "Sixty")], { more: true })));
    show();
    await screen.findByText("Sixty");
    vi.mocked(chatClient.page).mockImplementationOnce(
      () => new Promise((r) => (older = r as never)) as never,
    );
    vi.mocked(chatClient.page).mockResolvedValue(
      ok(page([msg(10, SANA, "", { body: null, deletedAt: new Date().toISOString() })])),
    );
    await userEvent.click(screen.getByRole("button", { name: "Earlier messages" }));
    say({ c: CH, e: "deleted", m: 10 });
    await act(async () => older(ok(page([msg(10, SANA, "Regret")]))));
    await waitFor(() => expect(screen.queryByText("Regret")).toBeNull());
  });

  it("an answer that isn't a page is tried again, and nothing is stuck after it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(chatClient.page).mockResolvedValueOnce(ok(null) as never);
    show();
    await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    vi.mocked(chatClient.page).mockRejectedValueOnce(new Error("boom"));
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(3, SANA, "After all")])));
    say({ c: CH, e: "message", m: 3, u: SANA });
    await act(async () => void (await vi.advanceTimersByTimeAsync(6000)));
    expect(screen.getByText("After all")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a hidden tab reads nothing after a drop either, until it's looked at", async () => {
    show();
    await screen.findByText("Hello");
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    vi.mocked(chatClient.page).mockClear();
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(80, SANA, "Afresh")])));
    say({ c: "*", e: "reconnected" });
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    expect(chatClient.page).not.toHaveBeenCalled();
    vis.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(await screen.findByText("Afresh")).toBeInTheDocument();
  });

  it("when the crowd leaves, reads are close together again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    show();
    await screen.findByText("Hello");
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([])));
    say({ c: CH, e: "message", m: 10, u: SANA, w: 4000 });
    await act(async () => void (await vi.advanceTimersByTimeAsync(8000)));
    vi.mocked(chatClient.page).mockClear();
    for (let i = 0; i < 8; i++) {
      say({ c: CH, e: "message", m: 20 + i, u: SANA });
      await act(async () => void (await vi.advanceTimersByTimeAsync(500)));
    }
    expect(vi.mocked(chatClient.page).mock.calls.length).toBeGreaterThanOrEqual(3);
    vi.useRealTimers();
  });

  it("one's own reaction, edit and delete show at once; one that's refused goes back as it was", async () => {
    show();
    const bubble = (t: string) => screen.getByText(t).closest("[role=group]") as HTMLElement;
    await screen.findByText("Hello");
    let answer!: (r: unknown) => void;
    vi.mocked(chatClient.react).mockImplementationOnce(
      () => new Promise((r) => (answer = r as never)) as never,
    );
    await userEvent.click(within(bubble("Morning")).getByRole("button", { name: "React 🎉" }));
    expect(within(bubble("Morning")).getByRole("button", { name: "🎉 1, yours" })).toBeInTheDocument();
    // Pressed again before the server answers: off, not on again.
    await userEvent.click(within(bubble("Morning")).getByRole("button", { name: "🎉 1, yours" }));
    expect(chatClient.react).toHaveBeenLastCalledWith(1, "🎉", false);
    expect(within(bubble("Morning")).queryByRole("button", { name: /^🎉/ })).toBeNull();
    await act(async () => answer(ok(undefined)));
    vi.mocked(chatClient.remove).mockResolvedValueOnce(bad("That message isn't there."));
    await userEvent.click(within(bubble("Hello")).getByRole("button", { name: "Delete" }));
    await userEvent.click(within(bubble("Hello")).getByRole("button", { name: "Delete for everyone?" }));
    expect(await screen.findByText("That message isn't there.")).toBeInTheDocument();
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    // Something that works takes the last problem off the screen.
    await userEvent.click(within(bubble("Hello")).getByRole("button", { name: "React 👍" }));
    expect(screen.queryByText("That message isn't there.")).toBeNull();
  });

  it("one's own reaction, kept while the server answers, is counted once on a page that already has it", async () => {
    show();
    const bubble = (t: string) => screen.getByText(t).closest("[role=group]") as HTMLElement;
    await screen.findByText("Hello");
    let answer!: (r: unknown) => void;
    vi.mocked(chatClient.react).mockImplementationOnce(
      () => new Promise((r) => (answer = r as never)) as never,
    );
    await userEvent.click(within(bubble("Morning")).getByRole("button", { name: "React 🎉" }));
    // First a page from before the server had it, then one that has it.
    vi.mocked(chatClient.page).mockClear();
    say({ c: CH, e: "reaction", m: 1 });
    await waitFor(() => expect(chatClient.page).toHaveBeenLastCalledWith(CH, { after: 0 }));
    await act(async () => undefined);
    expect(within(bubble("Morning")).getByRole("button", { name: "🎉 1, yours" })).toBeInTheDocument();
    vi.mocked(chatClient.page).mockClear();
    vi.mocked(chatClient.page).mockResolvedValue(
      ok(page([msg(1, SANA, "Morning", { reactions: [{ emoji: "🎉", count: 1, mine: true }] })])),
    );
    say({ c: CH, e: "reaction", m: 1 });
    await waitFor(() => expect(chatClient.page).toHaveBeenLastCalledWith(CH, { after: 0 }));
    await act(async () => undefined);
    expect(within(bubble("Morning")).getByRole("button", { name: "🎉 1, yours" })).toBeInTheDocument();
    await act(async () => answer(ok(undefined)));
    expect(within(bubble("Morning")).getByRole("button", { name: "🎉 1, yours" })).toBeInTheDocument();
  });

  it("one's own delete, not answered yet, stays deleted when a page brings the message as it was", async () => {
    show();
    const bubble = (t: string) => screen.getByText(t).closest("[role=group]") as HTMLElement;
    await screen.findByText("Hello");
    vi.mocked(chatClient.remove).mockImplementationOnce(() => new Promise(() => undefined) as never);
    await userEvent.click(within(bubble("Hello")).getByRole("button", { name: "Delete" }));
    await userEvent.click(within(bubble("Hello")).getByRole("button", { name: "Delete for everyone?" }));
    expect(screen.queryByText("Hello")).toBeNull();
    vi.mocked(chatClient.page).mockClear();
    say({ c: CH, e: "reaction", m: 2 });
    await waitFor(() => expect(chatClient.page).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByText("Hello")).toBeNull();
    expect(screen.getByText("This message was deleted")).toBeInTheDocument();
  });

  it("a kept reaction never shows on a message a page says was deleted", async () => {
    show();
    const bubble = (t: string) => screen.getByText(t).closest("[role=group]") as HTMLElement;
    await screen.findByText("Hello");
    vi.mocked(chatClient.react).mockImplementationOnce(() => new Promise(() => undefined) as never);
    await userEvent.click(within(bubble("Morning")).getByRole("button", { name: "React 🎉" }));
    vi.mocked(chatClient.page).mockClear();
    vi.mocked(chatClient.page).mockResolvedValue(
      ok(page([msg(1, SANA, "", { body: null, deletedAt: new Date().toISOString() })])),
    );
    say({ c: CH, e: "deleted", m: 1 });
    await waitFor(() => expect(chatClient.page).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.getByText("This message was deleted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^🎉/ })).toBeNull();
  });

  it("an edit just saved never brings back a message a page then says was deleted", async () => {
    show();
    const b = await box();
    await screen.findByText("Hello");
    // A read that went out before the save is answered after it, with the message deleted (in another tab).
    let answer!: (r: unknown) => void;
    vi.mocked(chatClient.page).mockImplementationOnce(
      () => new Promise((r) => (answer = r as never)) as never,
    );
    say({ c: CH, e: "reaction", m: 2 });
    await waitFor(() => expect(chatClient.page).toHaveBeenLastCalledWith(CH, { after: 1 }));
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.type(b, " there");
    vi.mocked(chatClient.edit).mockResolvedValueOnce(
      ok(msg(2, ME, "Hello there", { editedAt: new Date().toISOString() })),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Hello there")).toBeInTheDocument();
    await act(async () =>
      answer(ok(page([msg(2, ME, "", { body: null, deletedAt: new Date().toISOString() })]))),
    );
    expect(screen.queryByText("Hello there")).toBeNull();
    expect(screen.getByText("This message was deleted")).toBeInTheDocument();
  });

  it("an edit that names someone who can't read it says so to its sender", async () => {
    show();
    const b = await box();
    await screen.findByText("Hello");
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.type(b, " Rahul");
    vi.mocked(chatClient.edit).mockResolvedValueOnce(ok(msg(2, ME, "Hello Rahul", { notTold: [RAHUL] })));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Not told, as they can't read this: Rahul Mehta")).toBeInTheDocument();
  });

  it("a send that lands after leaving and coming back is there at once", async () => {
    let answer!: (r: unknown) => void;
    vi.mocked(chatClient.send).mockImplementationOnce(
      () => new Promise((r) => (answer = r as never)) as never,
    );
    show();
    await userEvent.type(await box(), "On its way{Enter}");
    const c1 = vi.mocked(chatClient.send).mock.calls[0]![1].clientId;
    await userEvent.click(screen.getByRole("button", { name: /deals/ }));
    await box("Message #deals");
    await userEvent.click(screen.getByRole("button", { name: /sales/ }));
    await screen.findByText("Hello");
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([])));
    await act(async () => answer(ok(msg(3, ME, "On its way", { clientId: c1 }))));
    expect(screen.getAllByText("On its way")).toHaveLength(1);
  });

  it("someone who keeps no place in a lead's thread is shown nothing as new; its owner is", async () => {
    vi.mocked(chatClient.leadThread).mockResolvedValue(ok({ id: CH }));
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(1, SANA, "Said")], { lastReadId: null })));
    const tab = (
      <LeadTeam lead={{ id: id(8), name: "Priya", stage: null }} me={ME} zone="Asia/Kolkata" people={[]} />
    );
    const { unmount } = render(tab);
    await screen.findByText("Said");
    expect(screen.queryByText("New")).toBeNull();
    unmount();
    vi.mocked(chatClient.page).mockResolvedValue(ok(page([msg(1, SANA, "Said")], { lastReadId: 0 })));
    render(tab);
    expect(await screen.findByText("New")).toBeInTheDocument();
  });

  it("the buttons on a message are one stop for the keyboard until it's reached", async () => {
    show();
    const b = (await screen.findByText("Hello")).closest("[role=group]") as HTMLElement;
    expect(within(b).getByRole("button", { name: "Reply" })).toHaveAttribute("tabindex", "-1");
    act(() => b.focus());
    expect(within(b).getByRole("button", { name: "Reply" })).toHaveAttribute("tabindex", "0");
    act(() => b.blur());
    expect(within(b).getByRole("button", { name: "Reply" })).toHaveAttribute("tabindex", "-1");
    // A file can be chosen from the keyboard.
    expect(screen.getByLabelText(/Attach a photo or file/)).not.toHaveAttribute("hidden");
    const pick = screen.getByLabelText(/Attach a photo or file/);
    act(() => pick.focus());
    expect(pick).toHaveFocus();
  });
});

describe("getting around", () => {
  it("on a phone the list comes first, and nothing is read until one is opened", async () => {
    phone.on = true;
    show({ openId: null });
    expect(screen.getByText("Choose a conversation.")).toBeInTheDocument();
    expect(chatClient.page).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /sales/ }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Choose a conversation.")).toBeInTheDocument();
  });

  it("a link to a lead's thread that isn't in the list opens it; one that isn't there says so", async () => {
    vi.mocked(chatClient.one).mockResolvedValue(
      ok(row({ id: id(77), kind: "lead", name: null, lead: { id: id(8), name: "  ", stage: null } })),
    );
    const { unmount } = show({ openId: id(77) });
    expect(await screen.findByRole("heading", { name: "Lead with no name" })).toBeInTheDocument();
    unmount();
    vi.mocked(chatClient.one).mockResolvedValue(bad("That conversation isn't there."));
    show({ openId: id(78) });
    expect(await screen.findByText("That conversation isn't there.")).toBeInTheDocument();
  });

  it("a direct message starts from the list: only people who can be messaged", async () => {
    vi.mocked(chatClient.direct).mockResolvedValue(ok({ id: id(99) }));
    vi.mocked(chatClient.one).mockResolvedValue(
      ok(
        row({
          id: id(99),
          kind: "direct",
          name: null,
          people: [{ id: SANA, name: "Sana Iqbal", avatar: null as never }],
        }),
      ),
    );
    show();
    await userEvent.click(screen.getByRole("button", { name: "New direct message" }));
    const sheet = await screen.findByRole("dialog", { name: "New direct message" });
    expect(within(sheet).queryByText("Old Person")).toBeNull();
    expect(within(sheet).queryByText("Maya Kapoor")).toBeNull();
    await userEvent.type(within(sheet).getByRole("searchbox"), "sana");
    expect(within(sheet).queryByText("Rahul Mehta")).toBeNull();
    await userEvent.click(within(sheet).getByRole("checkbox", { name: /Sana Iqbal/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Start" }));
    expect(chatClient.direct).toHaveBeenCalledWith([SANA]);
    expect(await screen.findByRole("heading", { name: "Sana Iqbal" })).toBeInTheDocument();
  });

  it("mute from the conversation", async () => {
    show();
    await screen.findByText("Hello");
    const muteTold = vi.fn();
    const off = onMuted(muteTold);
    await userEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(chatClient.mute).toHaveBeenCalledWith(CH, true);
    expect(screen.getByRole("button", { name: "Muted" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(muteTold).toHaveBeenCalled());
    off();
  });

  it("channels are made and changed by whoever manages them, and by no one else", async () => {
    const { unmount } = show();
    await screen.findByText("Hello");
    expect(screen.queryByRole("button", { name: "Manage channels" })).toBeNull();
    unmount();
    vi.mocked(chatClient.channels).mockResolvedValue(
      ok({
        channels: [
          {
            id: CH2,
            name: "deals",
            topic: null,
            archived: false,
            people: [RAHUL],
            members: 1200,
            groups: [],
          },
          { id: id(52), name: "old", topic: null, archived: true, people: [], members: 0, groups: [] },
        ],
        teams: [{ id: id(60), name: "Floor" }],
        roles: [],
      }),
    );
    vi.mocked(chatClient.makeChannel).mockResolvedValue(ok({ id: id(70) }));
    show({ canManage: true });
    await userEvent.click(screen.getByRole("button", { name: "Manage channels" }));
    const all = await screen.findByRole("dialog", { name: "Channels" });
    expect(await within(all).findByText("1,200 in it")).toBeInTheDocument();
    await userEvent.click(within(all).getByRole("button", { name: /deals/ }));
    const form = await screen.findByRole("dialog", { name: "#deals" });
    await userEvent.click(within(form).getByRole("switch", { name: "Floor" }));
    await userEvent.click(within(form).getByRole("checkbox", { name: /Sana Iqbal/ }));
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    // The name wasn't touched: only who's in it changes.
    expect(chatClient.changeChannel).not.toHaveBeenCalled();
    expect(chatClient.setMembers).toHaveBeenCalledWith(CH2, {
      people: [RAHUL, SANA],
      groups: [{ kind: "team", id: id(60) }],
    });
    await userEvent.click(await screen.findByRole("button", { name: "New channel" }));
    const fresh = await screen.findByRole("dialog", { name: "New channel" });
    expect(within(fresh).getByRole("button", { name: "Make channel" })).toBeDisabled();
    await userEvent.type(within(fresh).getByRole("textbox", { name: "Name" }), "Hot Deals");
    await userEvent.click(within(fresh).getByRole("button", { name: "Make channel" }));
    expect(chatClient.makeChannel).toHaveBeenCalledWith({ name: "hot-deals", people: [ME], groups: [] });
    await userEvent.click(await screen.findByRole("button", { name: /old/ }));
    const back = await screen.findByRole("dialog", { name: "#old" });
    vi.mocked(chatClient.changeChannel).mockResolvedValueOnce(bad("There's already a channel called #old."));
    await userEvent.click(within(back).getByRole("button", { name: "Bring back" }));
    expect(await within(back).findByText("There's already a channel called #old.")).toBeInTheDocument();
    expect(chatClient.changeChannel).toHaveBeenCalledWith(id(52), { archived: false, name: "old" });
  });

  it("a lead renamed while its Team tab is open keeps the conversation as it is", async () => {
    vi.mocked(chatClient.leadThread).mockResolvedValue(ok({ id: CH }));
    const tab = (name: string) => (
      <LeadTeam lead={{ id: id(8), name, stage: null }} me={ME} zone="Asia/Kolkata" people={[]} />
    );
    const { rerender } = render(tab(""));
    expect(
      await screen.findByText("Only people who can see this lead read this. The lead never does."),
    ).toBeInTheDocument();
    const b = await box("Message Lead with no name");
    await userEvent.type(b, "Half");
    rerender(tab("Priya Shah"));
    expect(await box("Message Priya Shah")).toHaveValue("Half");
    expect(chatClient.leadThread).toHaveBeenCalledTimes(1);
  });
});
