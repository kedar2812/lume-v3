import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { templatesClient } from "@/lib/templates/client";
import { QuickTemplates } from "./QuickTemplates";

vi.mock("@/lib/templates/client", () => ({
  templatesClient: { list: vi.fn(), context: vi.fn() },
}));
const ok = <T,>(data: T) => ({ ok: true as const, data });

beforeEach(() => {
  vi.mocked(templatesClient.list).mockResolvedValue(
    ok({
      templates: [
        {
          id: "t1",
          name: "Thanks",
          body: "Hi {{lead.first_name}}, thanks for your message.",
          category: "follow_up",
        },
        { id: "t2", name: "Price list", body: "Our prices start at ₹2,000.", category: "general" },
      ],
    }) as never,
  );
  vi.mocked(templatesClient.context).mockResolvedValue(
    ok({
      lead: { name: "Zara Khan", custom: {} },
      owner: null,
      business: { name: "Brightpath", currency: "INR", timezone: "Asia/Dubai" },
      fields: [],
      people: [],
    }) as never,
  );
});

/** A reply from the business's own templates: free to send inside the 24 hours, no LUME AI (owner 2026-11-02). */
describe("templates in the reply box", () => {
  it("lists the business's templates in this lead's words; one tap puts it in the box to send or change", async () => {
    const onPick = vi.fn();
    render(<QuickTemplates leadId="l1" onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: "Templates" }));
    const thanks = await screen.findByRole("menuitem", { name: /Thanks/ });
    await userEvent.click(thanks);
    expect(onPick).toHaveBeenCalledWith("Hi Zara, thanks for your message.");
    expect(templatesClient.context).toHaveBeenCalledWith("l1");
  });

  it("none yet: says so, and where they're made", async () => {
    vi.mocked(templatesClient.list).mockResolvedValue(ok({ templates: [] }) as never);
    render(<QuickTemplates leadId="l1" onPick={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Templates" }));
    expect(await screen.findByText(/No templates yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Templates" })).toHaveAttribute("href", "/templates");
  });
});
