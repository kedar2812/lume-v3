import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppEvent } from "@/lib/notifications/stream";
import { whatsappClient } from "@/lib/whatsapp/client";
import { useChatOnScreen } from "@/lib/whatsapp/open-chats";
import { MessageNotices, NOTICE_MS, chatHref } from "./MessageNotices";

let hear: (e: WhatsAppEvent) => void = () => undefined;
vi.mock("@/lib/notifications/stream", () => ({
  useWhatsApp: (on: (e: WhatsAppEvent) => void) => {
    hear = on;
  },
}));
vi.mock("@/lib/whatsapp/client", () => ({ whatsappClient: { latest: vi.fn() } }));

const ME = "u-me";
const latest = vi.mocked(whatsappClient.latest);
const says = (name: string | null, text: string | null, at: string, media?: { kind: "audio" | "image" }) =>
  latest.mockResolvedValueOnce({
    ok: true,
    status: 200,
    data: { name, message: { id: at, direction: "in", text, at, ...(media ? { media } : {}) } },
  } as never);
/** A message in for this lead; `owner` null: one whose owner the stream didn't know. */
const arrives = async (lead: string, owner: string | null = ME) => {
  await act(async () => {
    hear({ lead, kind: "in", ...(owner ? { owner } : {}) });
    await Promise.resolve();
  });
};
const notices = () => screen.queryAllByRole("button", { name: /Open the chat$/ });

function Shell(p: { repliesOn?: boolean; onOpen?: (id: string) => void; openChat?: string | null }) {
  useChatOnScreen(p.openChat ?? null);
  return (
    <MessageNotices
      userId={ME}
      tz="Asia/Kolkata"
      repliesOn={p.repliesOn ?? true}
      onOpen={p.onOpen ?? vi.fn()}
    />
  );
}

describe("a notice for each WhatsApp message in (2026-11-01)", () => {
  beforeEach(() => latest.mockReset());
  afterEach(() => vi.useRealTimers());

  it("who, what they wrote and when; pressing it opens their chat and puts it away", async () => {
    const onOpen = vi.fn();
    render(<Shell onOpen={onOpen} />);
    says("Mrunal Desale", "Is Saturday still on?", "2026-11-01T05:50:00Z");
    await arrives("lead-1");
    const n = await screen.findByRole("button", {
      name: "Mrunal Desale on WhatsApp: Is Saturday still on?. Open the chat",
    });
    expect(within(n).getByText("11:20 am")).toBeInTheDocument();
    await userEvent.click(n);
    expect(onOpen).toHaveBeenCalledWith("lead-1");
    await waitFor(() => expect(notices()).toHaveLength(0));
  });

  it("not this person's lead, a message out or a tick, alerts off, or the chat already on screen: nothing, and nothing read", async () => {
    const { rerender } = render(<Shell />);
    await arrives("lead-1", "someone-else");
    await arrives("lead-1", null);
    await act(async () => hear({ lead: "lead-1", kind: "out" }));
    await act(async () => hear({ lead: "lead-1", kind: "status" }));
    rerender(<Shell repliesOn={false} />);
    await arrives("lead-1");
    rerender(<Shell openChat="lead-1" />);
    await arrives("lead-1");
    expect(latest).not.toHaveBeenCalled();
    expect(notices()).toHaveLength(0);
  });

  it("its chat opened another way (the lead's drawer): the notice goes at once, never over the open chat (gate 2026-11-04)", async () => {
    const { rerender } = render(<Shell />);
    says("Riya Kapoor", "Is Saturday free for a visit?", "2026-11-01T05:50:00Z");
    says("Kedar", "hello", "2026-11-01T05:51:00Z");
    await arrives("lead-1");
    await arrives("lead-2");
    await waitFor(() => expect(notices()).toHaveLength(2));
    // On a phone the chat fills the screen, and a notice left over it covered its Close button.
    rerender(<Shell openChat="lead-1" />);
    await waitFor(() =>
      expect(notices().map((n) => n.getAttribute("aria-label"))).toEqual([
        "Kedar on WhatsApp: hello. Open the chat",
      ]),
    );
  });

  it("a second message from the same lead updates their notice; a photo or voice note says so; a fourth lead pushes out the oldest", async () => {
    render(<Shell />);
    says("Kedar", "hello", "2026-11-01T05:50:00Z");
    await arrives("lead-1");
    says("Kedar", null, "2026-11-01T05:51:00Z", { kind: "audio" });
    await arrives("lead-1");
    expect(await screen.findByText("Voice note")).toBeInTheDocument();
    expect(screen.getByText("2 new messages")).toBeInTheDocument();
    expect(notices()).toHaveLength(1);
    for (const [i, who] of ["Asha", "Ravi", "Zoya"].entries()) {
      says(who, `hi ${i}`, `2026-11-01T06:0${i}:00Z`);
      await arrives(`lead-${i + 2}`);
    }
    await screen.findByText("Zoya");
    await waitFor(() => {
      expect(notices()).toHaveLength(3);
      expect(screen.queryByText("Kedar")).not.toBeInTheDocument();
    });
  });

  it("the same message told twice (a replay) is one; a lead that can't be seen any more says nothing", async () => {
    render(<Shell />);
    says("Kedar", "hello", "2026-11-01T05:50:00Z");
    await arrives("lead-1");
    says("Kedar", "hello", "2026-11-01T05:50:00Z");
    await arrives("lead-1");
    await screen.findByText("hello");
    expect(screen.queryByText(/new messages/)).not.toBeInTheDocument();
    latest.mockResolvedValueOnce({ ok: false, status: 404, message: "Not found" } as never);
    await arrives("lead-9");
    expect(notices()).toHaveLength(1);
  });

  it("goes after a while on its own; Dismiss puts it away at once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Shell />);
    says("Kedar", "hello", "2026-11-01T05:50:00Z");
    await arrives("lead-1");
    expect(notices()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(NOTICE_MS + 50));
    await waitFor(() => expect(notices()).toHaveLength(0));
    says("Asha", "hi", "2026-11-01T05:52:00Z");
    await arrives("lead-2");
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss Asha's message" }));
    await waitFor(() => expect(notices()).toHaveLength(0));
  });
});

describe("where a notice goes", () => {
  it("this lead's chat on Leads, keeping Leads' own filters; from anywhere else, Leads", () => {
    expect(chatHref("L1", { pathname: "/leads", search: "?view=v1&stage=s2" }, 7)).toBe(
      "/leads?view=v1&stage=s2&lead=L1&chat=7",
    );
    expect(chatHref("L1", { pathname: "/leads", search: "?lead=L0&chat=3" }, 8)).toBe(
      "/leads?lead=L1&chat=8",
    );
    expect(chatHref("L1", { pathname: "/today", search: "?x=1" }, 9)).toBe("/leads?lead=L1&chat=9");
  });
});
