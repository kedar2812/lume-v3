import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaPerson } from "@/lib/whatsapp/types";
import { NotYet } from "./NotYet";

const push = vi.fn();
const toast = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(whatsappClient.inbox).mockResolvedValue(
    ok({ people: [person(), person({ peer: "+919848012345", name: null, lastText: null, count: 1 })] }),
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
    expect(within(thread).getByText("Hi, do you do kitchens?")).toBeInTheDocument();
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

  it("nobody waiting: says so", async () => {
    vi.mocked(whatsappClient.inbox).mockResolvedValue(ok({ people: [] }));
    render(<NotYet tz={TZ} />);
    expect(
      await screen.findByText("Nobody’s waiting. Messages from numbers no lead has show up here."),
    ).toBeInTheDocument();
  });
});
