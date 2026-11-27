import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LumeChannel } from "@/lib/queues/client";
import type { WaThreadMessage } from "@/lib/whatsapp/types";
import { LumeSend, type LumePhase } from "./LumeSend";

const NOW = new Date("2026-11-26T10:00:00Z");
const outside: Extract<LumeChannel, { via: "lume" }> = {
  via: "lume",
  window: { open: false, lastInAt: null, until: null },
  template: {
    submissionId: "s1",
    name: "First hello",
    preview: "Hi Priya, this is the studio.",
    missing: [],
  },
  text: "Hi Priya, this is the studio.",
};
const inside: Extract<LumeChannel, { via: "lume" }> = {
  ...outside,
  window: {
    open: true,
    lastInAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
    until: new Date(NOW.getTime() + 21 * 3_600_000).toISOString(),
  },
};
const msg = (o: Partial<WaThreadMessage>): WaThreadMessage =>
  ({
    id: "m1",
    direction: "in",
    at: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
    text: "Is the evening batch open?",
    media: null,
    sentBy: null,
    status: null,
    problem: null,
    outboxId: null,
    lumeAi: null,
    ...o,
  }) as WaThreadMessage;

type Through = Extract<LumeChannel, { via: "lume" }>;
function card(o: {
  channel?: Through;
  messages?: WaThreadMessage[] | null;
  phase?: LumePhase;
  problem?: string | null;
}) {
  const onSend = vi.fn();
  const onSkip = vi.fn();
  const onRetry = vi.fn();
  render(
    <LumeSend
      leadName="Priya Shah"
      tz="Asia/Kolkata"
      now={NOW}
      channel={o.channel ?? outside}
      messages={o.messages === undefined ? [] : o.messages}
      phase={o.phase ?? "ready"}
      problem={o.problem ?? null}
      onSend={onSend}
      onSkip={onSkip}
      onRetry={onRetry}
    />,
  );
  return { onSend, onSkip, onRetry };
}

describe("a lead sent from inside LUME", () => {
  it("they haven't written in 24 hours: the approved template, in their words, read only; Send sends it", async () => {
    const { onSend } = card({});
    expect(screen.getByText("Hi Priya, this is the studio.")).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Sends your approved template First hello")).toBeVisible();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Send/ }));
    expect(onSend).toHaveBeenCalledWith({ mode: "template" });
  });

  it("a value the template needs is missing: says which, Send off, Skip on", async () => {
    const { onSend, onSkip } = card({
      channel: { ...outside, template: { ...outside.template!, missing: ["First name"] } },
    });
    expect(screen.getByText("Needs their First name filled in first")).toBeVisible();
    expect(screen.getByRole("button", { name: /^Send/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^Skip/ }));
    expect(onSkip).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("they wrote in the last 24 hours: says so, and offers Message (the default, editable) or the template", async () => {
    const { onSend } = card({ channel: inside, messages: [msg({})] });
    expect(screen.getByText("Wrote 3 hours ago · you can text them directly")).toBeVisible();
    expect(screen.getByRole("radio", { name: "Message" })).toBeChecked();
    const box = screen.getByRole("textbox", { name: "Message to Priya Shah" });
    expect(box).toHaveValue("Hi Priya, this is the studio.");
    await userEvent.clear(box);
    await userEvent.type(box, "Yes, 6 pm works!");
    await userEvent.click(screen.getByRole("button", { name: /^Send/ }));
    expect(onSend).toHaveBeenLastCalledWith({ mode: "message", text: "Yes, 6 pm works!" });
    await userEvent.click(screen.getByRole("radio", { name: "Template" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Send/ }));
    expect(onSend).toHaveBeenLastCalledWith({ mode: "template" });
  });

  it("never {{…}} to a customer: a value the words name but this lead hasn't got stops Send until it's filled", async () => {
    const { onSend } = card({ channel: { ...inside, text: "Hi Priya, about {{lead.custom.goal}}." } });
    expect(screen.getByText("Missing: lead.custom.goal. Fill it in before sending.")).toBeVisible();
    expect(screen.getByRole("button", { name: /^Send/ })).toBeDisabled();
    const box = screen.getByRole("textbox", { name: "Message to Priya Shah" });
    await userEvent.clear(box);
    await userEvent.type(box, "Hi Priya, about fat loss.");
    await userEvent.click(screen.getByRole("button", { name: /^Send/ }));
    expect(onSend).toHaveBeenCalledWith({ mode: "message", text: "Hi Priya, about fat loss." });
  });

  it("M and T switch between Message and Template, but not while typing", async () => {
    card({ channel: inside });
    await userEvent.keyboard("t");
    expect(screen.getByRole("radio", { name: "Template" })).toBeChecked();
    await userEvent.keyboard("m");
    expect(screen.getByRole("radio", { name: "Message" })).toBeChecked();
    await userEvent.click(screen.getByRole("textbox", { name: "Message to Priya Shah" }));
    await userEvent.keyboard("t");
    expect(screen.getByRole("radio", { name: "Message" })).toBeChecked();
  });

  it("inside the 24 hours with no approved template: a message, nothing to choose", () => {
    card({ channel: { ...inside, template: null } });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message to Priya Shah" })).toBeVisible();
  });

  it("their choice stands: nothing can go, says why, Skip only", async () => {
    const { onSkip } = card({
      channel: {
        ...outside,
        template: null,
        blocked: "This person turned off marketing messages from you on WhatsApp.",
      },
    });
    expect(screen.getByText("This person turned off marketing messages from you on WhatsApp.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Send/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Skip/ }));
    expect(onSkip).toHaveBeenCalled();
  });

  it("the conversation is there: their messages, or that there are none yet", () => {
    card({ channel: inside, messages: [msg({ text: "Is the evening batch open?" })] });
    expect(screen.getByText("Is the evening batch open?")).toBeVisible();
  });

  it("no messages yet: says so", () => {
    card({ messages: [] });
    expect(screen.getByText("No messages with them yet")).toBeVisible();
  });

  it("while it goes, when it went, when WhatsApp refused it, and when it's slow", async () => {
    card({ phase: "sending" });
    expect(screen.getByRole("button", { name: /^Sending/ })).toBeDisabled();
  });

  it("WhatsApp refused it: its words, Try again and Skip", async () => {
    const { onRetry, onSkip } = card({ phase: "failed", problem: "This number isn't on WhatsApp." });
    expect(screen.getByRole("alert")).toHaveTextContent("This number isn't on WhatsApp.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^Skip/ }));
    expect(onSkip).toHaveBeenCalled();
  });

  it("slow: LUME keeps trying, and says so", () => {
    card({ phase: "slow" });
    expect(screen.getByRole("status")).toHaveTextContent("Still sending, LUME will keep trying");
  });

  it("sent: says so", () => {
    card({ phase: "sent" });
    expect(screen.getByRole("status")).toHaveTextContent("Sent");
  });
});
