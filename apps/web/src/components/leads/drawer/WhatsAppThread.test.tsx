import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaMediaInfo, WaThreadMessage } from "@/lib/whatsapp/types";
import { WhatsAppThread } from "./WhatsAppThread";

vi.mock("@/lib/whatsapp/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp/client")>()),
  whatsappClient: { mediaInfo: vi.fn() },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const TZ = "Asia/Kolkata";
const msg = (o: Partial<WaThreadMessage> & { id: string }): WaThreadMessage => ({
  direction: "in",
  at: "2026-10-21T06:00:00.000Z",
  text: null,
  media: null,
  ...o,
});
const info = (o: Partial<WaMediaInfo>): WaMediaInfo => ({
  status: "ready",
  problem: null,
  kind: "image",
  mime: "image/jpeg",
  filename: null,
  size: 2048,
  voice: false,
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T12:00:00Z")); // Wednesday 5:30 pm in Kolkata
});
afterEach(() => vi.useRealTimers());

describe("the WhatsApp thread on a lead (spec 2026-10-18 §4.2; canvas board Thread)", () => {
  it("in time order, by day; theirs on one side, the phone's on the other, each heard as one message", () => {
    render(
      <WhatsAppThread
        leadName="Sneha Reddy"
        tz={TZ}
        messages={[
          msg({ id: "1", at: "2026-10-17T04:32:00.000Z", text: "Hi, saw your ad." }),
          msg({ id: "2", direction: "out", at: "2026-10-17T04:35:00.000Z", text: "Yes we do!" }),
          msg({ id: "3", at: "2026-10-21T10:52:00.000Z", text: "Yes, Saturday works." }),
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "WhatsApp messages with Sneha" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "October 17, Saturday",
      "Sneha, 10:02 am: Hi, saw your ad.",
      "From the phone, 10:05 am: Yes we do!",
      "Today",
      "Sneha, 4:22 pm: Yes, Saturday works.",
    ]);
    expect(items[2]).toHaveAttribute("data-direction", "out");
  });

  it("a photo shows once it's here, with words for screen readers", async () => {
    vi.mocked(whatsappClient.mediaInfo).mockResolvedValue(ok(info({})));
    render(
      <WhatsAppThread
        leadName="Sneha Reddy"
        tz={TZ}
        messages={[
          msg({
            id: "1",
            media: { id: "m1", kind: "image", mime: "image/jpeg", filename: null, voice: false },
          }),
        ]}
      />,
    );
    const img = await screen.findByRole("img", { name: "Photo from Sneha" });
    expect(img).toHaveAttribute("src", "/api/v1/whatsapp/media/m1");
  });

  it("a voice note plays in place; a document is a download with its name and size", async () => {
    vi.mocked(whatsappClient.mediaInfo).mockImplementation(async (id) =>
      ok(
        id === "a1"
          ? info({ kind: "audio", mime: "audio/ogg", voice: true })
          : info({ kind: "document", mime: "application/pdf", filename: "Floor plan.pdf", size: 1_258_291 }),
      ),
    );
    const { container } = render(
      <WhatsAppThread
        leadName="Sneha Reddy"
        tz={TZ}
        messages={[
          msg({
            id: "1",
            media: { id: "a1", kind: "audio", mime: "audio/ogg", filename: null, voice: true },
          }),
          msg({
            id: "2",
            media: {
              id: "d1",
              kind: "document",
              mime: "application/pdf",
              filename: "Floor plan.pdf",
              voice: false,
            },
          }),
        ]}
      />,
    );
    const link = await screen.findByRole("link", { name: /Floor plan\.pdf/ });
    expect(link).toHaveAttribute("href", "/api/v1/whatsapp/media/d1");
    expect(link).toHaveTextContent("PDF · 1.2 MB");
    const audio = container.querySelector("audio")!;
    expect(audio).toHaveAttribute("src", "/api/v1/whatsapp/media/a1");
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute("aria-label", "Voice note from Sneha");
  });

  it("waiting, and too large: said in words", async () => {
    vi.mocked(whatsappClient.mediaInfo).mockImplementation(async (id) =>
      ok(
        id === "w1"
          ? info({ status: "waiting" })
          : info({
              kind: "video",
              status: "too_large",
              problem: "This file is over 25 MB. Open it on the phone.",
            }),
      ),
    );
    render(
      <WhatsAppThread
        leadName="Sneha Reddy"
        tz={TZ}
        messages={[
          msg({
            id: "1",
            media: { id: "w1", kind: "image", mime: "image/jpeg", filename: null, voice: false },
          }),
          msg({
            id: "2",
            media: { id: "v1", kind: "video", mime: "video/mp4", filename: null, voice: false },
          }),
        ]}
      />,
    );
    expect(await screen.findByText("Getting this photo from WhatsApp…")).toBeInTheDocument();
    expect(await screen.findByText("This file is over 25 MB. Open it on the phone.")).toBeInTheDocument();
  });

  it("files LUME let go, or the disk lost, and files waiting for a reason: said in words (2026-10-19)", async () => {
    const words: Record<string, Partial<WaMediaInfo>> = {
      r1: {
        status: "removed",
        problem: "LUME keeps WhatsApp files for 6 months. This one is still on the phone.",
      },
      x1: { status: "missing", problem: "This file isn't on the server any more. It's still on the phone." },
      f1: { status: "waiting", problem: "The server's disk is full. LUME will try again." },
    };
    vi.mocked(whatsappClient.mediaInfo).mockImplementation(async (id) => ok(info(words[id]!)));
    render(
      <WhatsAppThread
        leadName="Sneha Reddy"
        tz={TZ}
        messages={Object.keys(words).map((id, i) =>
          msg({
            id: String(i),
            media: { id, kind: "image", mime: "image/jpeg", filename: null, voice: false },
          }),
        )}
      />,
    );
    for (const w of Object.values(words)) expect(await screen.findByText(w.problem!)).toBeInTheDocument();
    expect(screen.queryByText(/Getting this photo/)).toBeNull();
  });

  it("a file on its way is looked at again until it's here", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(whatsappClient.mediaInfo)
      .mockResolvedValueOnce(ok(info({ status: "waiting" })))
      .mockResolvedValue(ok(info({})));
    render(
      <WhatsAppThread
        leadName="Sneha Reddy"
        tz={TZ}
        messages={[
          msg({
            id: "1",
            media: { id: "m1", kind: "image", mime: "image/jpeg", filename: null, voice: false },
          }),
        ]}
      />,
    );
    expect(await screen.findByText("Getting this photo from WhatsApp…")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await screen.findByRole("img", { name: "Photo from Sneha" })).toBeInTheDocument();
  });

  it("a photo that won't load says so instead of a broken image", async () => {
    vi.mocked(whatsappClient.mediaInfo).mockResolvedValue(ok(info({})));
    render(
      <WhatsAppThread
        leadName="Sneha Reddy"
        tz={TZ}
        messages={[
          msg({
            id: "1",
            media: { id: "m1", kind: "image", mime: "image/jpeg", filename: null, voice: false },
          }),
        ]}
      />,
    );
    const img = await screen.findByRole("img", { name: "Photo from Sneha" });
    fireEvent.error(img);
    expect(
      await screen.findByText("LUME couldn’t show this photo. Open it on the phone."),
    ).toBeInTheDocument();
  });

  it("nothing yet: says so, naming the lead (no guessed pronoun)", () => {
    render(<WhatsAppThread leadName="Sneha Reddy" tz={TZ} messages={[]} />);
    expect(
      screen.getByText(
        "No WhatsApp messages with Sneha yet. When Sneha writes to your number, it shows up here.",
      ),
    ).toBeInTheDocument();
  });
});
