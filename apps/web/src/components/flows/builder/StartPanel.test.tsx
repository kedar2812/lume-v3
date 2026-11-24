import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flowsClient, type FlowTrigger } from "@/lib/flows/client";
import { StartPanel, type TriggerDraft } from "./StartPanel";

/** Starts when (plan 2026-11-23-flow-builder, Task B2): the ways in, saved with Save; the keyword tester. */
vi.mock("@/lib/flows/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/flows/client")>()),
  flowsClient: { testKeyword: vi.fn() },
}));
const comment: FlowTrigger = {
  kind: "comment",
  accountId: null,
  keywords: ["guide"],
  mode: "word",
  mediaIds: [],
  adIds: [],
  publicReplies: [],
  cooldownHours: 24,
  enabled: true,
};
beforeEach(() => vi.clearAllMocks());

/** The builder's side: it keeps the draft (so closing the panel loses nothing) and the saved list. */
function Panel({
  triggers,
  onSave = vi.fn(async () => ({ ok: true })),
  onDraft = vi.fn(),
}: {
  triggers: FlowTrigger[];
  onSave?: (t: FlowTrigger[]) => Promise<{ ok: boolean; message?: string }>;
  onDraft?: (d: TriggerDraft | null) => void;
}) {
  const [draft, setDraft] = useState<TriggerDraft | null>(null);
  return (
    <StartPanel
      flowId="f1"
      triggers={triggers}
      draft={draft}
      onDraft={(d) => {
        onDraft(d);
        setDraft(d);
      }}
      onSave={onSave}
      onClose={vi.fn()}
    />
  );
}
const keywords = () => screen.getByRole("textbox", { name: /Keywords/ });

describe("Starts when", () => {
  it("keywords typed with commas are saved as a list, each once, only when Save is pressed", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const onDraft = vi.fn();
    render(<Panel triggers={[comment]} onSave={onSave} onDraft={onDraft} />);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(keywords(), { target: { value: "guide, PRICE ,  plan, price" } });
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledWith([{ ...comment, keywords: ["guide", "PRICE", "plan"] }]);
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
    // Saved: the draft is let go, so the panel shows what the server has.
    expect(onDraft).toHaveBeenLastCalledWith(null);
  });

  it("ways in from the server carry ids: they aren't a change, and are never sent back (review 2026-11-24)", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    render(<Panel triggers={[{ ...comment, id: "t-1" }]} onSave={onSave} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(keywords(), { target: { value: "guide, free" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith([{ ...comment, keywords: ["guide", "free"] }]);
  });

  it("changing what starts it and back: the keywords are what the box shows", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    render(<Panel triggers={[comment]} onSave={onSave} />);
    const kind = screen.getByRole("combobox", { name: "Starts when someone" });
    fireEvent.change(kind, { target: { value: "story_reply" } });
    fireEvent.change(kind, { target: { value: "dm" } });
    expect(keywords()).toHaveValue("guide");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith([{ ...comment, kind: "dm", keywords: ["guide"] }]);
  });

  it("changing what starts it keeps what wasn't changed: its account and its cooldown", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    const one = { ...comment, accountId: "a-1", cooldownHours: 2 };
    render(<Panel triggers={[one]} onSave={onSave} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Starts when someone" }), {
      target: { value: "story_reply" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith([
      { ...comment, kind: "story_reply", accountId: "a-1", cooldownHours: 2, keywords: [], mode: "any" },
    ]);
  });

  it("whatever the words: no keywords go; back to keywords, they're what the box shows", async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    render(<Panel triggers={[comment]} onSave={onSave} />);
    const mode = screen.getByRole("combobox", { name: "Which words" });
    fireEvent.change(mode, { target: { value: "any" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenLastCalledWith([{ ...comment, mode: "any", keywords: [] }]);
    fireEvent.change(mode, { target: { value: "exact" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenLastCalledWith([{ ...comment, mode: "exact", keywords: ["guide"] }]);
  });

  it("a keyword longer than LUME keeps is said, and Save waits", () => {
    render(<Panel triggers={[comment]} />);
    fireEvent.change(keywords(), { target: { value: "x".repeat(101) } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("A keyword can be up to 100 characters.")).toBeInTheDocument();
    fireEvent.change(keywords(), { target: { value: "x".repeat(100) } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("with two ways in, each control says which one it's for", () => {
    render(<Panel triggers={[comment, { ...comment, kind: "dm" }]} />);
    expect(screen.getByRole("combobox", { name: "Starts when someone, way in 2" })).toHaveValue("dm");
    expect(screen.getByRole("button", { name: "Remove this way in, way in 1" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "On, way in 2" })).toBeChecked();
    expect(screen.getAllByRole("textbox", { name: /A public reply/ })).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: /A public reply.*way in 1/ })).toBeInTheDocument();
  });

  it("a refusal is said in its own words, and the changes stay", async () => {
    const onSave = vi.fn(async () => ({ ok: false, message: "Another live flow already answers PRICE." }));
    const onDraft = vi.fn();
    render(<Panel triggers={[comment]} onSave={onSave} onDraft={onDraft} />);
    fireEvent.change(keywords(), { target: { value: "price" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Another live flow already answers PRICE.");
    expect(onDraft).not.toHaveBeenCalledWith(null);
    expect(keywords()).toHaveValue("price");
  });

  it("the tester: whether the words start this flow, and which other flows they'd start too", async () => {
    vi.mocked(flowsClient.testKeyword).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        starts: true,
        keyword: "guide",
        overlaps: [{ flowId: "f2", name: "Freebies", keyword: "guide" }],
      },
    });
    render(<Panel triggers={[comment]} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Words to try" }), {
      target: { value: "the guide please" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Try" }));
    expect(flowsClient.testKeyword).toHaveBeenCalledWith({
      text: "the guide please",
      keywords: ["guide"],
      mode: "word",
      flowId: "f1",
    });
    const said = await screen.findByText(/Starts this flow/);
    expect(said).toHaveTextContent('Starts this flow (the keyword "guide").');
    expect(screen.getByText(/Would also start "Freebies"/)).toBeInTheDocument();
  });

  it("the tester tries each way in with its own match: an exact one is tried as exact", async () => {
    vi.mocked(flowsClient.testKeyword).mockImplementation(async (b) => ({
      ok: true,
      status: 200,
      data: {
        starts: b.mode === "exact",
        keyword: b.mode === "exact" ? "price" : null,
        overlaps: [{ flowId: "f2", name: "Freebies", keyword: "price" }],
      },
    }));
    render(<Panel triggers={[comment, { ...comment, kind: "dm", keywords: ["price"], mode: "exact" }]} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Words to try" }), { target: { value: "price" } });
    await userEvent.click(screen.getByRole("button", { name: "Try" }));
    expect(flowsClient.testKeyword).toHaveBeenCalledWith({
      text: "price",
      keywords: ["guide"],
      mode: "word",
      flowId: "f1",
    });
    expect(flowsClient.testKeyword).toHaveBeenCalledWith({
      text: "price",
      keywords: ["price"],
      mode: "exact",
      flowId: "f1",
    });
    expect(await screen.findByText(/Starts this flow/)).toHaveTextContent('(the keyword "price")');
    // The same other flow, said once.
    expect(screen.getAllByText(/Would also start "Freebies"/)).toHaveLength(1);
  });
});
