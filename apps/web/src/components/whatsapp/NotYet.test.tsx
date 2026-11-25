import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { instagramClient } from "@/lib/instagram/client";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaPerson } from "@/lib/whatsapp/types";
import { NotYet } from "./NotYet";

const push = vi.fn();
const toast = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
vi.mock("@/lib/instagram/client", () => ({
  instagramClient: { inbox: vi.fn(), inboxPerson: vi.fn(), makeLead: vi.fn(), ignore: vi.fn() },
}));
vi.mock("@/lib/whatsapp/client", () => ({
  whatsappClient: { inbox: vi.fn(), inboxPerson: vi.fn(), makeLead: vi.fn(), ignore: vi.fn() },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const person = (o: Partial<WaPerson> = {}): WaPerson => ({
  peer: "+919000000777",
  name: "Ravi K",
  number: { id: "n1", display: "+91 90000 00001" },
  count: 2,
  lastText: "And wardrobes too?",
  lastAt: "2026-10-21T11:01:00.000Z",
  ...o,
});
const TZ = "Asia/Kolkata";
const igPerson = (o: Record<string, unknown> = {}) => ({
  threadId: "t1",
  username: "priya.eats",
  name: "Priya Shah",
  account: { id: "a1", username: "maya.coach" },
  count: 2,
  lastText: "Do you do plans for PCOS?",
  lastAt: "2026-10-21T12:00:00.000Z",
  ...o,
});
const off = (message: string, status = 0) => ({ ok: false, status, code: "OFFLINE", message }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(whatsappClient.inbox).mockResolvedValue(
    ok({ people: [person(), person({ peer: "+919848012345", name: null, lastText: null, count: 1 })] }),
  );
  vi.mocked(instagramClient.inbox).mockResolvedValue(ok({ people: [] }));
  vi.mocked(instagramClient.inboxPerson).mockResolvedValue(
    ok({
      messages: [
        {
          id: "g1",
          at: "2026-10-21T11:59:00.000Z",
          text: null,
          unsent: false,
          detail: { story: { id: "s" } },
        },
        {
          id: "g2",
          at: "2026-10-21T12:00:00.000Z",
          text: "Do you do plans for PCOS?",
          unsent: false,
          detail: {},
        },
      ],
    }),
  );
  vi.mocked(whatsappClient.inboxPerson).mockResolvedValue(
    ok({
      messages: [
        { id: "i1", at: "2026-10-21T10:58:00.000Z", text: "Hi, do you do kitchens?", mediaId: null },
        { id: "i2", at: "2026-10-21T11:01:00.000Z", text: "And wardrobes too?", mediaId: null },
      ],
    }),
  );
});

describe("Not a lead yet (spec 2026-10-18 §4.1; canvas board NotYet)", () => {
  it("everyone who wrote, newest first; the first one open with their messages", async () => {
    render(<NotYet tz={TZ} />);
    const list = await screen.findByRole("list", { name: "People who wrote" });
    const rows = within(list).getAllByRole("link");
    expect(rows[0]).toHaveTextContent("Ravi K");
    expect(rows[0]).toHaveTextContent("And wardrobes too?");
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    // No name: the number; a photo with no words: said as a message.
    expect(rows[1]).toHaveTextContent("+91 98480 12345");
    const thread = await screen.findByRole("list", { name: "Messages from Ravi K" });
    // The list is there before its messages are: wait for them (a loaded suite lost that race, 2026-11-02).
    expect(await within(thread).findByText("Hi, do you do kitchens?")).toBeInTheDocument();
  });

  it("Make it an enquiry opens the new lead", async () => {
    vi.mocked(whatsappClient.makeLead).mockResolvedValue(ok({ leadId: "lead-9" }));
    render(<NotYet tz={TZ} />);
    await userEvent.click(await screen.findByRole("button", { name: "Make it an enquiry" }));
    expect(whatsappClient.makeLead).toHaveBeenCalledWith("n1", "+919000000777");
    expect(push).toHaveBeenCalledWith("/leads?lead=lead-9");
  });

  it("Not a lead: gone from the list at once, and said", async () => {
    vi.mocked(whatsappClient.ignore).mockResolvedValue(ok({ ignored: true as const }));
    render(<NotYet tz={TZ} />);
    await userEvent.click(await screen.findByRole("button", { name: "Not a lead" }));
    expect(whatsappClient.ignore).toHaveBeenCalledWith("n1", "+919000000777");
    expect(toast).toHaveBeenCalledWith({
      tone: "ok",
      title: "Not a lead",
      detail: "LUME won’t show this number here again.",
    });
    expect(screen.queryByText("Ravi K")).toBeNull();
  });

  it("someone who can't add leads reads them, without the buttons only those who can may use", async () => {
    render(<NotYet tz={TZ} mayDecide={false} />);
    const thread = await screen.findByRole("list", { name: "Messages from Ravi K" });
    expect(await within(thread).findByText("Hi, do you do kitchens?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not a lead" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make it an enquiry" })).toBeNull();
    expect(screen.getByText("Someone who can add leads decides who becomes one.")).toBeInTheDocument();
  });

  it("nobody waiting: says so", async () => {
    vi.mocked(whatsappClient.inbox).mockResolvedValue(ok({ people: [] }));
    render(<NotYet tz={TZ} />);
    expect(
      await screen.findByText("Nobody’s waiting. Messages from people who aren’t leads yet show up here."),
    ).toBeInTheDocument();
  });
});

describe("Not a lead yet with Instagram (plan 2026-11-25-instagram-screens D5; canvas board NotYet)", () => {
  beforeEach(() => {
    vi.mocked(instagramClient.inbox).mockResolvedValue(ok({ people: [igPerson()] }));
  });

  it("Instagram's people beside WhatsApp's, newest first, each saying where they wrote", async () => {
    render(<NotYet tz={TZ} />);
    const rows = within(await screen.findByRole("list", { name: "People who wrote" })).getAllByRole("link");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Priya Shah");
    expect(rows[0]).toHaveTextContent("@priya.eats");
    expect(rows[0]).toHaveTextContent("to @maya.coach");
    expect(rows[0]).toHaveTextContent("Instagram");
    const thread = await screen.findByRole("list", { name: "Messages from Priya Shah" });
    expect(await within(thread).findByText("Do you do plans for PCOS?")).toBeInTheDocument();
    expect(within(thread).getByText("Replied to your story")).toBeInTheDocument();
    expect(instagramClient.inboxPerson).toHaveBeenCalledWith("t1");
  });

  it("the channels filter the list, with how many each has", async () => {
    render(<NotYet tz={TZ} />);
    await screen.findByRole("list", { name: "People who wrote" });
    await userEvent.click(screen.getByRole("radio", { name: "Instagram · 1" }));
    const rows = within(screen.getByRole("list", { name: "People who wrote" })).getAllByRole("link");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Priya Shah");
  });

  it("someone masked shows masked, as the server sent it; with no name, their handle", async () => {
    vi.mocked(instagramClient.inbox).mockResolvedValue(
      ok({ people: [igPerson({ name: null, username: "pr•••" })] }),
    );
    render(<NotYet tz={TZ} />);
    const rows = within(await screen.findByRole("list", { name: "People who wrote" })).getAllByRole("link");
    expect(rows[0]).toHaveTextContent("@pr•••");
    expect(screen.queryByText(/priya/)).toBeNull();
  });

  it("Make it an enquiry, on Instagram, opens the new lead", async () => {
    vi.mocked(instagramClient.makeLead).mockResolvedValue(ok({ leadId: "lead-ig" }));
    render(<NotYet tz={TZ} />);
    await screen.findByRole("list", { name: "Messages from Priya Shah" });
    expect(
      screen.getByText(/LUME makes a lead with this name and handle, owned like the account it came to/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Make it an enquiry" }));
    expect(instagramClient.makeLead).toHaveBeenCalledWith("t1");
    expect(push).toHaveBeenCalledWith("/leads?lead=lead-ig");
  });

  it("Not a lead, on Instagram: gone, and said for a person, not a number", async () => {
    vi.mocked(instagramClient.ignore).mockResolvedValue(ok({ ignored: true as const }));
    render(<NotYet tz={TZ} />);
    await screen.findByRole("list", { name: "Messages from Priya Shah" });
    await userEvent.click(screen.getByRole("button", { name: "Not a lead" }));
    expect(instagramClient.ignore).toHaveBeenCalledWith("t1");
    expect(toast).toHaveBeenCalledWith({
      tone: "ok",
      title: "Not a lead",
      detail: "LUME won’t show this person here again.",
    });
  });

  it("made a lead somewhere else meanwhile: said, and taken off the list", async () => {
    vi.mocked(instagramClient.makeLead).mockResolvedValue(
      off("Nothing from this person is waiting here.", 404),
    );
    render(<NotYet tz={TZ} />);
    await screen.findByRole("list", { name: "Messages from Priya Shah" });
    await userEvent.click(screen.getByRole("button", { name: "Make it an enquiry" }));
    // Said as a notice, not on the next person's panel, which opens clean.
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Already gone",
          detail: "Nothing from this person is waiting here.",
        }),
      ),
    );
    expect(
      within(screen.getByRole("list", { name: "People who wrote" })).queryByText("Priya Shah"),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("WhatsApp off: Instagram's people alone; a full page offers the older ones", async () => {
    vi.mocked(whatsappClient.inbox).mockResolvedValue(off("off", 409));
    const many = Array.from({ length: 100 }, (_, i) =>
      igPerson({
        threadId: `t${i}`,
        name: `P${i}`,
        lastAt: new Date(Date.UTC(2026, 9, 21, 12, 0) - i * 60_000).toISOString(),
      }),
    );
    vi.mocked(instagramClient.inbox)
      .mockResolvedValueOnce(ok({ people: many }))
      .mockResolvedValueOnce(
        ok({
          people: [igPerson({ threadId: "old", name: "Older one", lastAt: "2026-10-01T00:00:00.000Z" })],
        }),
      );
    render(<NotYet tz={TZ} />);
    await screen.findByRole("list", { name: "People who wrote" });
    await userEvent.click(screen.getByRole("button", { name: "Show older" }));
    expect(instagramClient.inbox).toHaveBeenLastCalledWith(many[99]!.lastAt);
    expect(await screen.findByText("Older one")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
  });

  it('WhatsApp unreadable while Instagram answers: still said, never "Nobody\'s waiting"', async () => {
    vi.mocked(whatsappClient.inbox).mockResolvedValue(off("LUME couldn't reach the server."));
    vi.mocked(instagramClient.inbox).mockResolvedValue(ok({ people: [] }));
    render(<NotYet tz={TZ} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("LUME couldn't reach the server.");
    expect(screen.queryByText(/Nobody/)).toBeNull();
  });

  it("Show older twice at once asks once, and nobody shows twice", async () => {
    vi.mocked(whatsappClient.inbox).mockResolvedValue(off("off", 409));
    const many = Array.from({ length: 100 }, (_, i) =>
      igPerson({
        threadId: `t${i}`,
        name: `P${i}`,
        lastAt: new Date(Date.UTC(2026, 9, 21, 12) - i * 60_000).toISOString(),
      }),
    );
    let answer: (v: unknown) => void = () => {};
    vi.mocked(instagramClient.inbox)
      .mockResolvedValueOnce(ok({ people: many }))
      .mockReturnValueOnce(new Promise((r) => (answer = r)) as never);
    render(<NotYet tz={TZ} />);
    const more = await screen.findByRole("button", { name: "Show older" });
    await userEvent.dblClick(more);
    answer(
      ok({
        people: [igPerson({ threadId: "t99", name: "P99" }), igPerson({ threadId: "x", name: "Older one" })],
      }),
    );
    expect(await screen.findByText("Older one")).toBeInTheDocument();
    expect(instagramClient.inbox).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("P99")).toHaveLength(1);
  });

  it("neither can be read: says so", async () => {
    vi.mocked(whatsappClient.inbox).mockResolvedValue(off("LUME couldn't reach the server."));
    vi.mocked(instagramClient.inbox).mockResolvedValue(off("LUME couldn't reach the server."));
    render(<NotYet tz={TZ} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("LUME couldn't reach the server.");
  });
});
