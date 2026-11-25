import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { instagramClient } from "@/lib/instagram/client";
import { whatsappClient } from "@/lib/whatsapp/client";
import { NotYetLink } from "./NotYetLink";

vi.mock("@/lib/whatsapp/client", () => ({ whatsappClient: { inbox: vi.fn() } }));
vi.mock("@/lib/instagram/client", () => ({ instagramClient: { inbox: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const someone = {
  peer: "+91",
  name: null,
  number: { id: "n", display: "+91" },
  count: 1,
  lastText: null,
  lastAt: "",
};

describe("Not a lead yet, from Leads", () => {
  beforeEach(() => {
    vi.mocked(instagramClient.inbox).mockResolvedValue(ok({ people: [] }));
  });
  it("a link with how many are waiting", async () => {
    vi.mocked(whatsappClient.inbox).mockResolvedValue(ok({ people: [someone, { ...someone, peer: "+92" }] }));
    render(<NotYetLink />);
    expect(await screen.findByRole("link", { name: "Not a lead yet · 2" })).toHaveAttribute(
      "href",
      "/leads/not-yet",
    );
  });
  it("nothing when nobody is waiting", async () => {
    vi.mocked(whatsappClient.inbox).mockResolvedValue(ok({ people: [] }));
    const { container } = render(<NotYetLink />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
  it("counts Instagram's people too (plan 2026-11-25-instagram-screens D5); one channel off counts the other", async () => {
    vi.mocked(whatsappClient.inbox).mockResolvedValue({
      ok: false,
      status: 409,
      code: "OFF",
      message: "",
    } as never);
    vi.mocked(instagramClient.inbox).mockResolvedValue(
      ok({ people: [{} as never, {} as never, {} as never] }),
    );
    render(<NotYetLink />);
    expect(await screen.findByRole("link", { name: "Not a lead yet · 3" })).toBeInTheDocument();
  });
  it("a full page of Instagram's says there are more", async () => {
    vi.mocked(whatsappClient.inbox).mockResolvedValue(ok({ people: [someone] }));
    vi.mocked(instagramClient.inbox).mockResolvedValue(
      ok({ people: Array.from({ length: 100 }, () => ({}) as never) }),
    );
    render(<NotYetLink />);
    expect(await screen.findByRole("link", { name: "Not a lead yet · 101+" })).toBeInTheDocument();
  });
});
