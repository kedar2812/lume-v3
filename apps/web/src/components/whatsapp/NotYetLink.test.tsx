import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { whatsappClient } from "@/lib/whatsapp/client";
import { NotYetLink } from "./NotYetLink";

vi.mock("@/lib/whatsapp/client", () => ({ whatsappClient: { inbox: vi.fn() } }));
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
});
