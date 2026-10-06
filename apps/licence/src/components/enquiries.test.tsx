// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client";
import { EnquiriesScreen } from "./EnquiriesScreen";
import { EnquiryScreen } from "./EnquiryScreen";

vi.mock("@/lib/client", () => ({
  CHANGED: "lume-licence:changed",
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/enquiries",
}));

const ok = <T,>(data: T) => ({ ok: true as const, data });
const ENQ = {
  id: "e1",
  createdAt: "2026-10-07T05:00:00.000Z",
  name: "Ananya Rao",
  business: "Petal & Plate Studio",
  whatsapp: "+919812345678",
  email: "ananya@example.com",
  teamSize: "2-5",
  how: "Instagram DMs and a Google Form",
  source: "website",
  status: "new",
  notes: "",
  updatedAt: "2026-10-07T05:00:00.000Z",
};

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.patch).mockReset();
});

describe("Enquiries (website spec §7)", () => {
  it("newest first: who, their business, team size and the status in words", async () => {
    vi.mocked(api.get).mockResolvedValue(ok({ enquiries: [ENQ], newCount: 1 }));
    render(<EnquiriesScreen />);
    const row = (await screen.findByRole("link", { name: /Ananya Rao/ })).closest("tr")!;
    expect(screen.getByRole("link", { name: /Ananya Rao/ })).toHaveAttribute("href", "/enquiries/e1");
    expect(within(row).getByText("Petal & Plate Studio")).toBeInTheDocument();
    expect(within(row).getByText("2–5")).toBeInTheDocument();
    expect(within(row).getByText("New")).toBeInTheDocument();
  });

  it("a status filter, as one radio group", async () => {
    vi.mocked(api.get).mockResolvedValue(ok({ enquiries: [ENQ], newCount: 1 }));
    render(<EnquiriesScreen />);
    await screen.findByRole("link", { name: /Ananya Rao/ });
    await userEvent.click(screen.getByRole("radio", { name: "Demo booked" }));
    expect(api.get).toHaveBeenLastCalledWith("/api/enquiries?status=demo_booked");
  });

  it("nothing yet, said plainly", async () => {
    vi.mocked(api.get).mockResolvedValue(ok({ enquiries: [], newCount: 0 }));
    render(<EnquiriesScreen />);
    expect(
      await screen.findByText("No enquiries yet. They arrive here from lumecrm.in."),
    ).toBeInTheDocument();
  });

  it("one enquiry: WhatsApp and email one tap away, the status saved at once", async () => {
    vi.mocked(api.get).mockResolvedValue(ok({ enquiry: ENQ }));
    vi.mocked(api.patch).mockResolvedValue(
      ok({ enquiry: { ...ENQ, status: "contacted", updatedAt: "2026-10-07T05:01:00.000Z" } }),
    );
    render(<EnquiryScreen id="e1" />);
    expect(await screen.findByRole("link", { name: "WhatsApp" })).toHaveAttribute(
      "href",
      "https://wa.me/919812345678",
    );
    expect(screen.getByRole("link", { name: "Email" })).toHaveAttribute("href", "mailto:ananya@example.com");
    await userEvent.click(screen.getByRole("radio", { name: "Contacted" }));
    expect(api.patch).toHaveBeenCalledWith("/api/enquiries/e1", {
      status: "contacted",
      expectedUpdatedAt: ENQ.updatedAt,
    });
    expect(screen.getByRole("radio", { name: "Contacted" })).toBeChecked();
  });

  it("a save over someone else's says so, with Reload", async () => {
    vi.mocked(api.get).mockResolvedValue(ok({ enquiry: ENQ }));
    vi.mocked(api.patch).mockResolvedValue({
      ok: false,
      status: 409,
      message: "Changed elsewhere — reload to see it.",
    });
    render(<EnquiryScreen id="e1" />);
    await screen.findByRole("link", { name: "WhatsApp" });
    await userEvent.click(screen.getByRole("radio", { name: "Won" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Changed elsewhere — reload to see it.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });
});
