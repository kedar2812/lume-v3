import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { instagramClient } from "@/lib/instagram/client";
import type { IgMessage, IgThread } from "@/lib/instagram/types";
import { InstagramTab } from "./InstagramTab";

vi.mock("@/lib/instagram/client", () => ({
  instagramClient: {
    send: vi.fn(),
    privateReply: vi.fn(),
    takeOver: vi.fn(),
    handBack: vi.fn(),
    replyPublicly: vi.fn(),
    hideComment: vi.fn(),
    deleteComment: vi.fn(),
  },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const NOW = new Date("2026-11-25T10:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const H = 3_600_000;

const msg = (over: Partial<IgMessage> = {}): IgMessage => ({
  id: crypto.randomUUID(),
  direction: "in",
  at: "2026-11-25T09:00:00.000Z",
  text: "Does it work for night shifts?",
  detail: {},
  unsent: false,
  sentBy: null,
  status: null,
  problem: null,
  reaction: null,
  outboxId: null,
  flow: null,
  fromPhone: false,
  humanAgent: false,
  privateReply: false,
  ...over,
});
const thread = (over: Partial<IgThread> = {}): IgThread => ({
  id: "t1",
  account: { id: "a1", username: "harbour.studio", connected: true },
  person: { name: "Priya Shah", username: "@priya.eats" },
  window: { state: "open", until: later(23 * H) },
  takenOver: null,
  flow: null,
  comments: [],
  source: null,
  messages: [msg()],
  ...over,
});
const props = (over: Partial<Parameters<typeof InstagramTab>[0]> = {}) => ({
  leadId: "l1",
  leadName: "Priya Shah",
  threads: [thread()],
  me: { id: "u-me", name: "Maya Kapoor" },
  canSend: true,
  tz: "Asia/Kolkata",
  now: NOW,
  onChanged: vi.fn(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(instagramClient.send).mockImplementation(async (_l, b) =>
    ok({
      message: msg({
        direction: "out",
        text: b.text,
        status: "queued",
        sentBy: { id: "u-me", name: "Maya Kapoor" },
      }),
    }),
  );
});

describe("the lead's Instagram tab (plan 2026-11-25-instagram-screens D2; boards Thread, Phone)", () => {
  it("names the conversation, its account and the person's handle as the server masked it", () => {
    render(
      <InstagramTab
        {...props({ threads: [thread({ person: { name: "Priya Shah", username: "@pr•••" } })] })}
      />,
    );
    const tab = screen.getByRole("region", { name: "Instagram with Priya Shah" });
    expect(tab).toHaveTextContent("@pr•••");
    expect(tab).toHaveTextContent("on @harbour.studio");
    expect(tab).not.toHaveTextContent("priya.eats");
  });

  it("who has it: a flow, with Take over", async () => {
    vi.mocked(instagramClient.takeOver).mockResolvedValue(
      ok({ takenOver: { id: "u-me", name: "Maya Kapoor" } }),
    );
    const p = props({ threads: [thread({ flow: { id: "f1", name: "Lunch box guide", waiting: true } })] });
    render(<InstagramTab {...p} />);
    expect(screen.getByText("Flow: Lunch box guide")).toBeInTheDocument();
    expect(screen.getByText(/waiting for Priya’s answer/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Take over" }));
    expect(instagramClient.takeOver).toHaveBeenCalledWith("t1");
    expect(p.onChanged).toHaveBeenCalled();
  });

  it("who has it: LUME AI, over a flow, with Take over; its messages say whose they are", async () => {
    vi.mocked(instagramClient.takeOver).mockResolvedValue(
      ok({ takenOver: { id: "u-me", name: "Maya Kapoor" } }),
    );
    const p = props({
      threads: [
        thread({
          ai: { runId: "r1", paused: false },
          flow: { id: "f1", name: "Lunch box guide", waiting: false },
          messages: [
            msg(),
            msg({
              direction: "out",
              text: "Yes, it does.",
              ai: true,
              sentBy: { id: "u2", name: "Rhea Rao" },
              status: "sent",
            }),
          ],
        }),
      ],
    });
    render(<InstagramTab {...p} />);
    expect(screen.getByText("LUME AI", { selector: "span" })).toHaveAttribute("data-who", "ai");
    expect(screen.queryByText("Flow: Lunch box guide")).toBeNull();
    expect(screen.getByText("LUME AI is answering, within Instagram’s 24 hours.")).toBeInTheDocument();
    expect(screen.getByText(/LUME AI for Rhea Rao/)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "Type to take over from LUME AI…");
    await userEvent.click(screen.getByRole("button", { name: "Take over" }));
    expect(instagramClient.takeOver).toHaveBeenCalledWith("t1");
  });

  it("LUME AI's run paused: the chip says so; a person who took over comes first", () => {
    const { rerender } = render(
      <InstagramTab {...props({ threads: [thread({ ai: { runId: "r1", paused: true } })] })} />,
    );
    expect(screen.getByText(/LUME AI’s run is paused/)).toBeInTheDocument();
    rerender(
      <InstagramTab
        {...props({
          threads: [
            thread({ ai: { runId: "r1", paused: false }, takenOver: { id: "u-me", name: "Maya Kapoor" } }),
          ],
        })}
      />,
    );
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.queryByText("LUME AI", { selector: "span" })).toBeNull();
  });

  it("who has it: you, with Hand back; someone else, by name", async () => {
    vi.mocked(instagramClient.handBack).mockResolvedValue(ok({ takenOver: null }));
    const { rerender } = render(
      <InstagramTab {...props({ threads: [thread({ takenOver: { id: "u-me", name: "Maya Kapoor" } })] })} />,
    );
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing automated writes to Priya until you hand Priya back/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Hand back" }));
    expect(instagramClient.handBack).toHaveBeenCalledWith("t1");
    rerender(
      <InstagramTab {...props({ threads: [thread({ takenOver: { id: "u2", name: "Rhea Rep" } })] })} />,
    );
    expect(screen.getByText("Rhea Rep")).toBeInTheDocument();
  });

  it("who has it: nobody in particular, your team", () => {
    render(<InstagramTab {...props()} />);
    expect(screen.getByText("Your team")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hand back" })).toBeNull();
  });

  it("Meta's window, as it is now: open, under an hour, only a person, ended, never written", () => {
    const line = (w: IgThread["window"]) => {
      const { unmount } = render(<InstagramTab {...props({ threads: [thread({ window: w })] })} />);
      const text = screen.getByRole("status", { name: "Instagram’s window" }).textContent;
      unmount();
      return text;
    };
    expect(line({ state: "open", until: later(23 * H) })).toMatch(/^Open for 23 hours/);
    expect(line({ state: "open", until: later(45 * 60_000) })).toMatch(/^Open for 45 minutes/);
    expect(line({ state: "human", until: later(3 * 24 * H) })).toMatch(/^Only a person can answer, until /);
    expect(line({ state: "closed", since: later(-H) })).toMatch(/Instagram’s 7 days ended/);
    expect(line({ state: "closed", since: null })).toMatch(/^No message from Priya on Instagram yet/);
    // An ad's 7 days: the day it ends, never a count of a hundred hours.
    expect(line({ state: "open", until: later(5 * 24 * H) })).toMatch(/^Open until \w+day, /);
  });

  it("sends as a person with Enter, a new line with Shift+Enter, and keeps one message per clientKey", async () => {
    const p = props();
    render(<InstagramTab {...p} />);
    const box = screen.getByRole("textbox", { name: "Reply to Priya Shah on Instagram" });
    await userEvent.type(box, "Hi Priya{Shift>}{Enter}{/Shift}Yes it does");
    expect(box).toHaveValue("Hi Priya\nYes it does");
    await userEvent.type(box, "{Enter}");
    expect(instagramClient.send).toHaveBeenCalledTimes(1);
    const [, body] = vi.mocked(instagramClient.send).mock.calls[0]!;
    expect(body).toMatchObject({ threadId: "t1", text: "Hi Priya\nYes it does" });
    expect(body.clientKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(box).toHaveValue("");
    expect(screen.getByText("Hi Priya", { exact: false })).toBeInTheDocument();
    expect(p.onChanged).toHaveBeenCalled();
  });

  it("a send refused says why, keeps the words, and Send again uses the same clientKey", async () => {
    vi.mocked(instagramClient.send).mockResolvedValueOnce({
      ok: false,
      status: 0,
      code: "OFFLINE",
      message: "LUME couldn't reach the server. Check your connection.",
    } as never);
    render(<InstagramTab {...props()} />);
    const box = screen.getByRole("textbox", { name: "Reply to Priya Shah on Instagram" });
    await userEvent.type(box, "See you then{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your connection");
    expect(box).toHaveValue("See you then");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const keys = vi.mocked(instagramClient.send).mock.calls.map(([, b]) => b.clientKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it("a long message: counted in Instagram's bytes, and Send waits until it fits", async () => {
    render(<InstagramTab {...props()} />);
    const box = screen.getByRole("textbox", { name: "Reply to Priya Shah on Instagram" });
    await userEvent.click(box);
    await userEvent.paste("🙂".repeat(251));
    expect(screen.getByText(/1,004 of 1,000/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await userEvent.type(box, "{Enter}");
    expect(instagramClient.send).not.toHaveBeenCalled();
  });

  it("taking over while typing keeps what was typed", async () => {
    vi.mocked(instagramClient.takeOver).mockResolvedValue(
      ok({ takenOver: { id: "u-me", name: "Maya Kapoor" } }),
    );
    const p = props({ threads: [thread({ flow: { id: "f1", name: "Lunch box guide", waiting: false } })] });
    const { rerender } = render(<InstagramTab {...p} />);
    const box = screen.getByRole("textbox", { name: "Reply to Priya Shah on Instagram" });
    expect(box).toHaveAttribute("placeholder", "Type to take over from Lunch box guide…");
    await userEvent.type(box, "Half done");
    await userEvent.click(screen.getByRole("button", { name: "Take over" }));
    rerender(<InstagramTab {...p} threads={[thread({ takenOver: { id: "u-me", name: "Maya Kapoor" } })]} />);
    expect(screen.getByRole("textbox", { name: "Reply to Priya Shah on Instagram" })).toHaveValue(
      "Half done",
    );
  });

  it("after 24 hours, only a person: said under the box, and the reply goes as one", () => {
    render(
      <InstagramTab
        {...props({ threads: [thread({ window: { state: "human", until: later(3 * 24 * H) } })] })}
      />,
    );
    expect(
      screen.getByText(/Instagram marks a reply now as a person’s. Flows never use it./),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reply to Priya Shah on Instagram" })).toBeEnabled();
  });

  it("closed: no box to type in, and the line says when it can open again", () => {
    render(
      <InstagramTab {...props({ threads: [thread({ window: { state: "closed", since: later(-H) } })] })} />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("status", { name: "Instagram’s window" })).toHaveTextContent(
      "once Priya writes again",
    );
  });

  it("someone who can't message the lead reads the conversation with no box and no Take over", () => {
    render(
      <InstagramTab
        {...props({
          canSend: false,
          threads: [thread({ flow: { id: "f1", name: "Guide", waiting: true } })],
        })}
      />,
    );
    expect(screen.getByText("Does it work for night shifts?")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("an account no longer connected: the messages stay, and it says replies can't go", () => {
    render(
      <InstagramTab
        {...props({
          threads: [thread({ account: { id: "a1", username: "harbour.studio", connected: false } })],
        })}
      />,
    );
    expect(screen.getByText(/@harbour.studio isn’t connected to LUME now/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("messages: who sent each, a flow by its name, unsent, from Instagram itself, and what came with it", () => {
    render(
      <InstagramTab
        {...props({
          threads: [
            thread({
              messages: [
                msg({ text: null, detail: { story: { id: "s1" }, attachments: [] } }),
                msg({
                  direction: "out",
                  text: "Here you go",
                  flow: "Lunch box guide",
                  sentBy: { id: "u0", name: "Maya Kapoor" },
                  status: "read",
                  privateReply: true,
                }),
                msg({ text: null, unsent: true }),
                msg({ direction: "out", text: "From my phone", fromPhone: true }),
                msg({ text: null, detail: { attachments: ["image"] } }),
                msg({
                  direction: "out",
                  text: "Pick one",
                  sentBy: { id: "u0", name: "Maya Kapoor" },
                  status: "sent",
                  detail: {
                    quickReplies: [
                      { title: "Prices", payload: "p" },
                      { title: "Hours", payload: "h" },
                    ],
                  },
                }),
              ],
            }),
          ],
        })}
      />,
    );
    const list = screen.getByRole("list", { name: "Messages" });
    expect(list).toHaveTextContent("Replied to your story");
    expect(list).toHaveTextContent("Lunch box guide · private reply");
    expect(list).toHaveTextContent("Seen");
    expect(list).toHaveTextContent("Unsent");
    expect(list).toHaveTextContent("From Instagram");
    expect(list).toHaveTextContent("A photo");
    expect(within(list).getByText("Prices")).toBeInTheDocument();
    expect(within(list).getByText("Hours")).toBeInTheDocument();
  });

  it("a message that didn't go: why, and Try again sends it once more as a retry", async () => {
    const p = props({
      threads: [
        thread({
          messages: [
            msg({
              direction: "out",
              text: "Hello again",
              status: "failed",
              problem: "Instagram didn't take it.",
              outboxId: "o1",
              sentBy: { id: "u-me", name: "Maya Kapoor" },
            }),
          ],
        }),
      ],
    });
    render(<InstagramTab {...p} />);
    expect(screen.getByText("Instagram didn't take it.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(instagramClient.send).toHaveBeenCalledWith(
      "l1",
      expect.objectContaining({ threadId: "t1", text: "Hello again", retryOf: "o1" }),
    );
  });

  it("comments: the one private reply while it's open, and what became of the others", async () => {
    vi.mocked(instagramClient.privateReply).mockResolvedValue(ok({ message: msg({ direction: "out" }) }));
    const p = props({
      threads: [
        thread({
          comments: [
            {
              id: "c1",
              at: later(-H),
              text: "GUIDE",
              mediaType: "REELS",
              privateReply: "none",
              replyOpen: true,
            },
            {
              id: "c2",
              at: later(-2 * H),
              text: "nice",
              mediaType: "REELS",
              privateReply: "sent",
              replyOpen: false,
            },
            {
              id: "c3",
              at: later(-8 * 24 * H),
              text: "old",
              mediaType: null,
              privateReply: "none",
              replyOpen: false,
            },
          ],
        }),
      ],
    });
    render(<InstagramTab {...p} />);
    const comments = screen.getByRole("list", { name: "Comments" });
    const [open, sent, old] = within(comments).getAllByRole("listitem");
    expect(sent).toHaveTextContent("Answered privately");
    expect(old).toHaveTextContent("Its 7 days for a private reply have ended");
    expect(within(old!).queryByRole("button")).toBeNull();
    await userEvent.click(within(open!).getByRole("button", { name: "Reply privately" }));
    await userEvent.type(
      within(open!).getByRole("textbox", { name: "Private reply to this comment" }),
      "Sent it!",
    );
    await userEvent.click(within(open!).getByRole("button", { name: "Send privately" }));
    expect(instagramClient.privateReply).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ text: "Sent it!", clientKey: expect.stringMatching(/^[0-9a-f-]{36}$/) }),
    );
    expect(p.onChanged).toHaveBeenCalled();
  });

  it("a comment's own actions (2026-11-27): reply publicly, hide or unhide, delete asked twice", async () => {
    const state = { hidden: false, deleted: false, publicReply: null, publicReplyUnsure: false };
    vi.mocked(instagramClient.replyPublicly).mockResolvedValue(
      ok({ ...state, publicReply: "Prices in your DMs" }),
    );
    vi.mocked(instagramClient.hideComment).mockResolvedValue(ok({ ...state, hidden: true }));
    vi.mocked(instagramClient.deleteComment).mockResolvedValue(ok({ ...state, deleted: true }));
    const base = {
      at: later(-H),
      mediaType: "REELS",
      privateReply: "sent" as const,
      replyOpen: false,
      hidden: false,
      deleted: false,
      publicReply: null,
      canReplyPublicly: true,
    };
    const p = props({
      threads: [
        thread({
          comments: [
            { ...base, id: "c1", text: "PRICE" },
            {
              ...base,
              id: "c2",
              text: "hidden one",
              hidden: true,
              canReplyPublicly: false,
              publicReply: "Thanks!",
            },
            { ...base, id: "c3", text: "gone", deleted: true, canReplyPublicly: false },
          ],
        }),
      ],
    });
    render(<InstagramTab {...p} />);
    const [one, two, three] = within(screen.getByRole("list", { name: "Comments" })).getAllByRole("listitem");
    expect(two).toHaveTextContent("Hidden on Instagram");
    expect(two).toHaveTextContent("Replied publicly: Thanks!");
    expect(within(two!).getByRole("button", { name: "Unhide" })).toBeInTheDocument();
    expect(within(two!).queryByRole("button", { name: "Reply publicly" })).toBeNull();
    expect(three).toHaveTextContent("Deleted from Instagram");
    expect(within(three!).queryByRole("button")).toBeNull();

    await userEvent.click(within(one!).getByRole("button", { name: "Reply publicly" }));
    await userEvent.type(
      within(one!).getByRole("textbox", { name: "Public reply to this comment" }),
      "Prices in your DMs",
    );
    await userEvent.click(within(one!).getByRole("button", { name: "Reply publicly" }));
    expect(instagramClient.replyPublicly).toHaveBeenCalledWith("c1", "Prices in your DMs");
    await userEvent.click(within(one!).getByRole("button", { name: "Hide" }));
    expect(instagramClient.hideComment).toHaveBeenCalledWith("c1", true);
    await userEvent.click(within(two!).getByRole("button", { name: "Unhide" }));
    expect(instagramClient.hideComment).toHaveBeenLastCalledWith("c2", false);
    await userEvent.click(within(one!).getByRole("button", { name: "Delete" }));
    expect(instagramClient.deleteComment).not.toHaveBeenCalled();
    await userEvent.click(within(one!).getByRole("button", { name: "Delete from Instagram?" }));
    expect(instagramClient.deleteComment).toHaveBeenCalledWith("c1");
    expect(p.onChanged).toHaveBeenCalledTimes(4);
  });

  it("Instagram refusing a comment action: said in its words, nothing claimed", async () => {
    vi.mocked(instagramClient.hideComment).mockResolvedValue({
      ok: false,
      status: 502,
      code: "INSTAGRAM_REFUSED",
      message: "Instagram didn't take that. Try again.",
    });
    const p = props({
      threads: [
        thread({
          comments: [
            {
              id: "c1",
              at: later(-H),
              text: "PRICE",
              mediaType: "REELS",
              privateReply: "sent",
              replyOpen: false,
              hidden: false,
              deleted: false,
              publicReply: null,
              canReplyPublicly: true,
            },
          ],
        }),
      ],
    });
    render(<InstagramTab {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Instagram didn't take that. Try again.");
    expect(p.onChanged).not.toHaveBeenCalled();
  });

  it("Delete asked, then Escape: back to Delete, nothing deleted; a reply that may be there says to check", async () => {
    const p = props({
      threads: [
        thread({
          comments: [
            {
              id: "c1",
              at: later(-H),
              text: "PRICE",
              mediaType: "REELS",
              privateReply: "sent",
              replyOpen: false,
              hidden: false,
              deleted: false,
              publicReply: "Sent you the prices",
              publicReplyUnsure: true,
              canReplyPublicly: false,
            },
          ],
        }),
      ],
    });
    render(<InstagramTab {...p} />);
    expect(
      screen.getByText(
        "Replied publicly, though Instagram didn’t answer: Sent you the prices. Check Instagram.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("button", { name: "Delete from Instagram?" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(instagramClient.deleteComment).not.toHaveBeenCalled();
  });

  it("several accounts: one conversation at a time, picked by account", async () => {
    render(
      <InstagramTab
        {...props({
          threads: [
            thread(),
            thread({
              id: "t2",
              account: { id: "a2", username: "maya.coach", connected: true },
              messages: [msg({ text: "On the other account" })],
            }),
          ],
        })}
      />,
    );
    expect(screen.queryByText("On the other account")).toBeNull();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Conversation on" }), "t2");
    expect(screen.getByText("On the other account")).toBeInTheDocument();
  });

  it("a name and handle at Instagram's longest stay whole for the pointer", () => {
    const name = "N".repeat(150);
    render(
      <InstagramTab
        {...props({
          leadName: name,
          threads: [thread({ person: { name, username: `@${"a".repeat(30)}` } })],
        })}
      />,
    );
    expect(screen.getByTitle(`@${"a".repeat(30)}`)).toBeInTheDocument();
  });

  it("a send that didn't go in one conversation keeps its key there; another conversation sends with its own", async () => {
    vi.mocked(instagramClient.send).mockResolvedValueOnce({
      ok: false,
      status: 0,
      code: "OFFLINE",
      message: "offline",
    } as never);
    render(
      <InstagramTab
        {...props({
          threads: [
            thread(),
            thread({ id: "t2", account: { id: "a2", username: "maya.coach", connected: true } }),
          ],
        })}
      />,
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Reply to Priya Shah on Instagram" }),
      "First{Enter}",
    );
    await screen.findByRole("alert");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Conversation on" }), "t2");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Reply to Priya Shah on Instagram" }),
      "Second{Enter}",
    );
    const [a, b] = vi.mocked(instagramClient.send).mock.calls.map(([, x]) => x);
    expect(a!.threadId).toBe("t1");
    expect(b!.threadId).toBe("t2");
    expect(b!.clientKey).not.toBe(a!.clientKey);
  });
});
