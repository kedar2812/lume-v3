import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WaThreadMessage } from "@/lib/whatsapp/types";
import { WhatsAppChat } from "./WhatsAppChat";

vi.mock("@/lib/whatsapp/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp/client")>()),
  whatsappClient: { mediaInfo: vi.fn() },
}));
const TZ = "Asia/Kolkata";
const msg = (o: Partial<WaThreadMessage> & { id: string }): WaThreadMessage => ({
  direction: "in",
  at: "2026-10-31T13:08:21.000Z",
  text: null,
  media: null,
  sentBy: null,
  status: null,
  problem: null,
  outboxId: null,
  lumeAi: null,
  ...o,
});
const MESSAGES = [
  msg({ id: "1", text: "hlo saw ur ad, what does lume do?" }),
  msg({
    id: "2",
    direction: "out",
    text: "hey there, how are you",
    status: "delivered",
    sentBy: { id: "u", name: "Kedar Gurav" },
  }),
];

/** The lead's WhatsApp as its own window (owner, 2026-10-31): over everything, the reply box pinned at its foot. */
describe("WhatsApp chat window", () => {
  it("a window of its own, named for the lead, with their number, the messages and the reply box at the foot", () => {
    render(
      <WhatsAppChat
        leadName="Kedar Gurav"
        phone="+91 88058 95066"
        tz={TZ}
        messages={MESSAGES}
        onClose={vi.fn()}
        composer={<textarea aria-label="Write to Kedar" />}
      />,
    );
    const chat = screen.getByRole("dialog", { name: "WhatsApp with Kedar Gurav" });
    expect(chat).toHaveAttribute("aria-modal", "true");
    expect(within(chat).getByRole("heading", { name: "Kedar Gurav" })).toBeInTheDocument();
    expect(within(chat).getByText("+91 88058 95066")).toBeInTheDocument();
    expect(within(chat).getByRole("list", { name: "WhatsApp messages with Kedar" })).toHaveTextContent(
      "hlo saw ur ad, what does lume do?",
    );
    // The reply box sits in the window's own foot, outside the scrolling messages.
    const foot = chat.querySelector("[data-chat-foot]")!;
    expect(within(foot as HTMLElement).getByRole("textbox", { name: "Write to Kedar" })).toBeInTheDocument();
    expect(chat.querySelector("[data-chat-body] textarea")).toBeNull();
  });

  it("Close and Escape close it", async () => {
    const onClose = vi.fn();
    render(
      <WhatsAppChat leadName="Kedar Gurav" phone={null} tz={TZ} messages={MESSAGES} onClose={onClose} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("no reply box (replying from LUME is off): says where replies go instead", () => {
    render(
      <WhatsAppChat leadName="Kedar Gurav" phone={null} tz={TZ} messages={MESSAGES} onClose={vi.fn()} />,
    );
    expect(screen.getByText(/Replies arrive here by themselves/)).toBeInTheDocument();
  });
});
