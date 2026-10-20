import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filesClient } from "@/lib/files/client";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaReply, WaThreadMessage } from "@/lib/whatsapp/types";
import { WhatsAppComposer } from "./WhatsAppComposer";
import { NO_PREVIEW } from "@/lib/files/testing";

vi.mock("@/lib/whatsapp/client", () => ({
  whatsappClient: {
    send: vi.fn(),
    attach: vi.fn(),
    attachFromLibrary: vi.fn(),
    templateState: vi.fn(),
    sendTemplate: vi.fn(),
  },
}));
vi.mock("@/lib/files/client", () => ({ filesClient: { list: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 202, data });
const TZ = "Asia/Kolkata";
const open: NonNullable<WaReply> = {
  allowed: true,
  number: { id: "n1", display: "+91 90000 00001", ownerName: null },
  until: "2026-10-21T10:42:00.000Z", // 4:12 pm in Kolkata
  reason: null,
};
const sent = (text: string): WaThreadMessage => ({
  id: "a1",
  direction: "out",
  at: "2026-10-21T06:00:00.000Z",
  text,
  media: null,
  sentBy: { id: "u1", name: "Priya" },
  status: "queued",
  problem: null,
  outboxId: "o1",
});
const box = () => screen.getByRole("textbox", { name: "Message to Sneha" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T06:00:00Z")); // 11:30 am in Kolkata
  vi.mocked(whatsappClient.send).mockImplementation(async (_lead, b) => ok({ message: sent(b.text ?? "") }));
  vi.mocked(whatsappClient.templateState).mockResolvedValue(ok(null));
});
afterEach(() => vi.useRealTimers());

describe("the reply box (plan W3a; canvas boards Main, Attached, Closed)", () => {
  it("says until when and from which number; Enter sends, Shift+Enter is a new line", async () => {
    const onSent = vi.fn();
    render(<WhatsAppComposer leadId="l1" leadName="Sneha Reddy" tz={TZ} reply={open} onSent={onSent} />);
    expect(screen.getByText("You can reply until 4:12 pm · From +91 90000 00001")).toBeInTheDocument();
    await userEvent.type(box(), "See you{Shift>}{Enter}{/Shift}Saturday");
    expect(box()).toHaveValue("See you\nSaturday");
    await userEvent.type(box(), "{Enter}");
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(sent("See you\nSaturday")));
    expect(whatsappClient.send).toHaveBeenCalledWith("l1", {
      clientKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      text: "See you\nSaturday",
    });
    expect(box()).toHaveValue("");
  });

  it("someone's own number, and a window ending tomorrow, said plainly", () => {
    render(
      <WhatsAppComposer
        leadId="l1"
        leadName="Sneha Reddy"
        tz={TZ}
        reply={{
          ...open,
          number: { ...open.number!, ownerName: "Priya Nair" },
          until: "2026-10-22T04:50:00.000Z",
        }}
        onSent={vi.fn()}
      />,
    );
    expect(
      screen.getByText("You can reply until 10:20 am tomorrow · From Priya Nair's number, +91 90000 00001"),
    ).toBeInTheDocument();
  });

  it("a double tap is one message; a send that didn't reach LUME is tried again as the same message", async () => {
    let release: () => void = () => undefined;
    vi.mocked(whatsappClient.send)
      .mockImplementationOnce(
        () =>
          new Promise(
            (r) =>
              (release = () =>
                r({ ok: false, status: 0, code: "OFFLINE", message: "You're offline." }) as never),
          ),
      )
      .mockImplementation(async (_l, b) => ok({ message: sent(b.text ?? "") }));
    render(<WhatsAppComposer leadId="l1" leadName="Sneha Reddy" tz={TZ} reply={open} onSent={vi.fn()} />);
    await userEvent.type(box(), "Hello");
    const send = screen.getByRole("button", { name: "Send" });
    await userEvent.click(send);
    await userEvent.click(send);
    expect(whatsappClient.send).toHaveBeenCalledTimes(1);
    release();
    expect(await screen.findByRole("alert")).toHaveTextContent("You're offline.");
    expect(box()).toHaveValue("Hello"); // nothing lost
    await userEvent.click(send);
    await waitFor(() => expect(whatsappClient.send).toHaveBeenCalledTimes(2));
    const [a, b] = vi.mocked(whatsappClient.send).mock.calls;
    expect(b![1].clientKey).toBe(a![1].clientKey);
  });

  it("a file attached shows its name and size, can be removed, and goes with the words as its caption", async () => {
    vi.mocked(whatsappClient.attach).mockResolvedValue(
      ok({
        media: {
          id: "m1",
          kind: "document",
          mime: "application/pdf",
          filename: "Price list.pdf",
          size: 1_258_291,
        },
      }),
    );
    render(<WhatsAppComposer leadId="l1" leadName="Sneha Reddy" tz={TZ} reply={open} onSent={vi.fn()} />);
    const file = new File(["%PDF-1.7"], "Price list.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Attach a photo or a file"), file);
    expect(await screen.findByText("Price list.pdf")).toBeInTheDocument();
    expect(screen.getByText("PDF · 1.2 MB")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Words with the file" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Words with the file" }), "Our prices{Enter}");
    await waitFor(() =>
      expect(whatsappClient.send).toHaveBeenCalledWith("l1", {
        clientKey: expect.any(String),
        mediaId: "m1",
        text: "Our prices",
      }),
    );
    expect(screen.queryByText("Price list.pdf")).toBeNull();
  });

  it("a file LUME refuses says why; removing an attached file leaves nothing to send", async () => {
    vi.mocked(whatsappClient.attach)
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        code: "FILE_TOO_BIG",
        message: "Photos can be up to 5 MB.",
      } as never)
      .mockResolvedValueOnce(
        ok({ media: { id: "m2", kind: "image", mime: "image/jpeg", filename: null, size: 2048 } }),
      );
    render(<WhatsAppComposer leadId="l1" leadName="Sneha Reddy" tz={TZ} reply={open} onSent={vi.fn()} />);
    const input = screen.getByLabelText("Attach a photo or a file");
    await userEvent.upload(input, new File(["x"], "big.jpg", { type: "image/jpeg" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Photos can be up to 5 MB.");
    await userEvent.upload(input, new File(["x"], "site.jpg", { type: "image/jpeg" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove site.jpg" }));
    expect(screen.queryByText("site.jpg")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("with the business's files: Attach offers this device or Media, and a picked file is ready to send", async () => {
    vi.mocked(filesClient.list).mockResolvedValue(
      ok({
        files: [
          {
            id: "f1",
            name: "Brochure.pdf",
            kind: "document",
            mime: "application/pdf",
            size: 1_258_291,
            link: { on: false, url: null, opens: 0 },
            createdAt: "2026-10-19T06:00:00.000Z",
            archived: false,
            ...NO_PREVIEW,
          },
        ],
      }),
    );
    vi.mocked(whatsappClient.attachFromLibrary).mockResolvedValue(
      ok({
        media: {
          id: "m9",
          kind: "document",
          mime: "application/pdf",
          filename: "Brochure.pdf",
          size: 1_258_291,
        },
      }),
    );
    render(
      <WhatsAppComposer leadId="l1" leadName="Sneha Reddy" tz={TZ} reply={open} library onSent={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(screen.getByRole("menuitem", { name: "From this device" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "From Media" }));
    await userEvent.click(await screen.findByRole("option", { name: /Brochure\.pdf/ }));
    await userEvent.click(screen.getByRole("button", { name: "Attach 1 file" }));
    expect(whatsappClient.attachFromLibrary).toHaveBeenCalledWith("l1", "f1");
    expect(await screen.findByText("PDF · 1.2 MB")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Words with the file" }), "Our brochure{Enter}");
    await waitFor(() =>
      expect(whatsappClient.send).toHaveBeenCalledWith("l1", {
        clientKey: expect.any(String),
        mediaId: "m9",
        text: "Our brochure",
      }),
    );
  });

  it("two files from Media: both ready to send, and each goes as its own message, the words with the first", async () => {
    const lib = (id: string, name: string, mime: string) => ({
      id,
      name,
      kind: mime.startsWith("image/") ? ("image" as const) : ("document" as const),
      mime,
      size: 1_258_291,
      link: { on: false, url: null, opens: 0 },
      createdAt: "2026-10-19T06:00:00.000Z",
      archived: false,
      ...NO_PREVIEW,
    });
    vi.mocked(filesClient.list).mockResolvedValue(
      ok({ files: [lib("f1", "Brochure.pdf", "application/pdf"), lib("f2", "Kitchen.jpg", "image/jpeg")] }),
    );
    vi.mocked(whatsappClient.attachFromLibrary).mockImplementation(async (_lead, id) =>
      ok({
        media:
          id === "f1"
            ? { id: "m1", kind: "document", mime: "application/pdf", filename: "Brochure.pdf", size: 1_258_291 }
            : { id: "m2", kind: "image", mime: "image/jpeg", filename: "Kitchen.jpg", size: 1_258_291 },
      }),
    );
    const onSent = vi.fn();
    render(<WhatsAppComposer leadId="l1" leadName="Sneha Reddy" tz={TZ} reply={open} library onSent={onSent} />);
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "From Media" }));
    await userEvent.click(await screen.findByRole("option", { name: /Brochure\.pdf/ }));
    await userEvent.click(screen.getByRole("option", { name: /Kitchen\.jpg/ }));
    await userEvent.click(screen.getByRole("button", { name: "Attach 2 files" }));
    expect(await screen.findByRole("button", { name: "Remove Brochure.pdf" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Remove Kitchen.jpg" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Words with the files" }), "As promised{Enter}");
    await waitFor(() => expect(whatsappClient.send).toHaveBeenCalledTimes(2));
    const [a, b] = vi.mocked(whatsappClient.send).mock.calls.map((c) => c[1]);
    expect(a).toEqual({ clientKey: expect.any(String), mediaId: "m1", text: "As promised" });
    expect(b).toEqual({ clientKey: expect.any(String), mediaId: "m2" });
    expect(a!.clientKey).not.toBe(b!.clientKey);
    expect(onSent).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Remove Kitchen.jpg" })).toBeNull();
  });

  it("one of several that isn't taken says so and stays to try again; the others go", async () => {
    vi.mocked(whatsappClient.attach).mockImplementation(async (_lead, f: File) =>
      ok({ media: { id: f.name === "a.jpg" ? "ma" : "mb", kind: "image", mime: "image/jpeg", filename: f.name, size: 2048 } }),
    );
    vi.mocked(whatsappClient.send).mockImplementation(async (_lead, body) =>
      body.mediaId === "ma"
        ? ({ ok: false, status: 502, code: "META", message: "WhatsApp didn't take it. Try again." } as never)
        : ok({ message: sent(body.text ?? "") }),
    );
    render(<WhatsAppComposer leadId="l1" leadName="Sneha Reddy" tz={TZ} reply={open} onSent={vi.fn()} />);
    await userEvent.upload(screen.getByLabelText("Attach a photo or a file"), [
      new File(["x"], "a.jpg", { type: "image/jpeg" }),
      new File(["y"], "b.jpg", { type: "image/jpeg" }),
    ]);
    await screen.findByRole("button", { name: "Remove b.jpg" });
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("WhatsApp didn't take it. Try again.");
    expect(whatsappClient.send).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Remove a.jpg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove b.jpg" })).toBeNull();
  });

  it("with the business's files, a file from this device still attaches as before", async () => {
    vi.mocked(whatsappClient.attach).mockResolvedValue(
      ok({ media: { id: "m3", kind: "image", mime: "image/jpeg", filename: null, size: 2048 } }),
    );
    render(
      <WhatsAppComposer leadId="l1" leadName="Sneha Reddy" tz={TZ} reply={open} library onSent={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "From this device" }));
    await userEvent.upload(
      screen.getByLabelText("Attach a photo or a file"),
      new File(["x"], "site.jpg", { type: "image/jpeg" }),
    );
    expect(await screen.findByRole("button", { name: "Remove site.jpg" })).toBeInTheDocument();
  });

  it("W3b-2: after WhatsApp's 24 hours, the business's approved templates are offered beside the reason", async () => {
    vi.mocked(whatsappClient.templateState).mockResolvedValue(
      ok({
        number: { id: "n1", display: "+91 90000 00001" },
        reason: null,
        options: [
          {
            submissionId: "s1",
            name: "Gentle nudge",
            category: "MARKETING" as const,
            preview: "Hi Sneha, still keen on a visit this week?",
            missing: [],
            cost: { amount: 0.86, currency: "INR", asOf: "2026-10-18" },
          },
        ],
      }),
    );
    render(
      <WhatsAppComposer
        leadId="l1"
        leadName="Sneha Reddy"
        tz={TZ}
        reply={{
          allowed: false,
          number: null,
          until: null,
          reason: "It's been over 24 hours since Sneha's last WhatsApp message.",
        }}
        onSent={vi.fn()}
      />,
    );
    expect(await screen.findByRole("radio", { name: /Gentle nudge/ })).toBeInTheDocument();
    expect(whatsappClient.templateState).toHaveBeenCalledWith("l1");
  });

  it("after WhatsApp's 24 hours: the reason, and the usual way to open WhatsApp; no box", () => {
    render(
      <WhatsAppComposer
        leadId="l1"
        leadName="Sneha Reddy"
        tz={TZ}
        reply={{
          allowed: false,
          number: null,
          until: null,
          reason:
            "It's been over 24 hours since Sneha's last WhatsApp message. Send it from the phone, or wait for Sneha to write again.",
        }}
        onSent={vi.fn()}
        fallback={<button type="button">Message</button>}
      />,
    );
    expect(
      screen.getByText(/It's been over 24 hours since Sneha's last WhatsApp message\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Message" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
