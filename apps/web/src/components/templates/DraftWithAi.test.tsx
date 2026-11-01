import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { templatesClient } from "@/lib/templates/client";
import { DraftWithAi } from "./DraftWithAi";

vi.mock("@/lib/templates/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/templates/client")>()),
  templatesClient: { draft: vi.fn() },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const OPTIONS = [
  {
    name: "Friendly follow-up",
    category: "follow_up" as const,
    body: "Hi {{lead.first_name}}, just checking in about your enquiry. Would a quick call this week help?",
    why: "Short and warm, with an easy yes.",
  },
  {
    name: "Helpful nudge",
    category: "follow_up" as const,
    body: "Hi {{lead.first_name}}, happy to answer any questions. What would be most useful to know?",
    why: "Invites a question when someone has gone quiet.",
  },
];
const FIELDS = [{ key: "city", type: "text" as const, label: "City" }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(templatesClient.draft).mockResolvedValue(ok({ options: OPTIONS }));
});

/** LUME AI writes templates (owner, 2026-10-31): a prompt, two or three to choose from, Use this into the editor. */
describe("Write with LUME AI", () => {
  it("say what it's for, write, and two or three to choose from, each with why", async () => {
    render(<DraftWithAi fields={FIELDS} onUse={vi.fn()} onClose={vi.fn()} />);
    const sheet = screen.getByRole("dialog", { name: "Write with LUME AI" });
    expect(within(sheet).getByRole("button", { name: "Write templates" })).toBeDisabled();
    await userEvent.type(
      within(sheet).getByRole("textbox", { name: "What should this template do?" }),
      "Follow up with leads who asked for pricing and went quiet",
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Write templates" }));
    expect(templatesClient.draft).toHaveBeenCalledWith(
      "Follow up with leads who asked for pricing and went quiet",
    );
    const cards = await within(sheet).findAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("Friendly follow-up");
    expect(cards[0]).toHaveTextContent("Follow-up");
    expect(cards[0]).toHaveTextContent("Short and warm, with an easy yes.");
    // Variables read as their names, as everywhere else in LUME's templates.
    expect(cards[0]).toHaveTextContent("First name");
  });

  it("a starter fills the request; Use this hands the draft to the editor", async () => {
    const onUse = vi.fn();
    render(<DraftWithAi fields={FIELDS} onUse={onUse} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Follow up after no reply" }));
    expect(screen.getByRole("textbox", { name: "What should this template do?" })).toHaveValue(
      "Follow up with leads who haven't replied in a few days",
    );
    await userEvent.click(screen.getByRole("button", { name: "Write templates" }));
    const cards = await screen.findAllByRole("article");
    await userEvent.click(within(cards[1]!).getByRole("button", { name: "Use this" }));
    expect(onUse).toHaveBeenCalledWith(OPTIONS[1]);
  });

  it("none LUME could send: said in words, with a way to try again", async () => {
    vi.mocked(templatesClient.draft).mockResolvedValue(ok({ options: [] }));
    render(<DraftWithAi fields={FIELDS} onUse={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole("textbox", { name: "What should this template do?" }), "Follow up");
    await userEvent.click(screen.getByRole("button", { name: "Write templates" }));
    expect(
      await screen.findByText(
        "LUME AI couldn't write one LUME could send for that. Try saying it another way.",
      ),
    ).toBeInTheDocument();
  });

  it("a refusal (LUME AI off, its limit): said in words", async () => {
    vi.mocked(templatesClient.draft).mockResolvedValue({
      ok: false,
      status: 400,
      code: "AI_OFF",
      message: "LUME AI is off. An admin can switch it on in Settings → Integrations.",
    } as never);
    render(<DraftWithAi fields={FIELDS} onUse={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole("textbox", { name: "What should this template do?" }), "Follow up");
    await userEvent.click(screen.getByRole("button", { name: "Write templates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("LUME AI is off.");
  });
});
