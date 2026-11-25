import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flowsClient } from "@/lib/flows/client";
import { NewFlowSheet } from "./NewFlowSheet";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/flows/client", () => ({ flowsClient: { create: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(flowsClient.create).mockResolvedValue({ ok: true, status: 201, data: { id: "f9" } as never });
});

describe("the New flow sheet (plan 2026-11-25-instagram-screens D4; canvas board NewFlow)", () => {
  it("every ready-made flow as a card, Start from nothing first, and one picked with its preview", () => {
    render(<NewFlowSheet onClose={vi.fn()} />);
    const sheet = screen.getByRole("dialog", { name: "New flow" });
    const cards = within(sheet).getAllByRole("option");
    expect(cards).toHaveLength(16);
    expect(cards[0]).toHaveTextContent("Start from nothing");
    // The most used is picked to begin with, its steps in the preview.
    expect(within(sheet).getByRole("option", { name: /Link for a comment/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const preview = within(sheet).getByRole("complementary", { name: "Link for a comment, step by step" });
    expect(preview).toHaveTextContent("Someone comments “LINK”");
    expect(within(preview).getAllByRole("listitem").length).toBeGreaterThan(1);
    expect(preview).toHaveTextContent("Add your link before it goes live.");
  });

  it("groups narrow the cards, with how many are in each", async () => {
    render(<NewFlowSheet onClose={vi.fn()} />);
    const events = screen.getByRole("tab", { name: /Events/ });
    expect(events).toHaveTextContent("2");
    await userEvent.click(events);
    const names = screen.getAllByRole("option").map((o) => o.querySelector("b")?.textContent);
    expect(names).toEqual(["Start from nothing", "Event sign-up", "Giveaway entry"]);
  });

  it("search finds by name, what it does or what starts it; nothing found says so", async () => {
    render(<NewFlowSheet onClose={vi.fn()} />);
    const box = screen.getByRole("searchbox", { name: "Search ready-made flows" });
    await userEvent.type(box, "price");
    const names = screen.getAllByRole("option").map((o) => o.querySelector("b")?.textContent);
    expect(names).toContain("Price question");
    expect(names).not.toContain("Giveaway entry");
    await userEvent.clear(box);
    await userEvent.type(box, "zzzz");
    expect(screen.getByText(/No ready-made flow fits “zzzz”/)).toBeInTheDocument();
  });

  it("Use this flow makes it as a draft under its own name and opens it on the canvas", async () => {
    render(<NewFlowSheet onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("option", { name: /Freebie for a comment/ }));
    await userEvent.click(screen.getByRole("button", { name: "Use this flow" }));
    expect(flowsClient.create).toHaveBeenCalledWith({
      name: "Freebie for a comment",
      template: "comment_freebie",
    });
    expect(push).toHaveBeenCalledWith("/instagram/flows/f9");
  });

  it("Start from nothing makes an empty draft", async () => {
    render(<NewFlowSheet onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("option", { name: /Start from nothing/ }));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(flowsClient.create).toHaveBeenCalledWith({ name: "New flow" });
  });

  it("refused: says why in the sheet and stays open; a double click makes one flow", async () => {
    let answer: (v: unknown) => void = () => {};
    vi.mocked(flowsClient.create).mockReturnValueOnce(new Promise((r) => (answer = r)) as never);
    render(<NewFlowSheet onClose={vi.fn()} />);
    const use = screen.getByRole("button", { name: "Use this flow" });
    await userEvent.dblClick(use);
    expect(flowsClient.create).toHaveBeenCalledTimes(1);
    answer({ ok: false, status: 409, code: "INSTAGRAM_OFF", message: "Instagram is off." });
    expect(await screen.findByRole("alert")).toHaveTextContent("Instagram is off.");
    expect(push).not.toHaveBeenCalled();
  });

  it("keyboard: arrows move between cards, Escape closes", async () => {
    const onClose = vi.fn();
    render(<NewFlowSheet onClose={onClose} />);
    screen.getByRole("option", { name: /Link for a comment/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("option", { name: /Freebie for a comment/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
