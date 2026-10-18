import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NextStep } from "@lume/core/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiClient } from "@/lib/ai/client";
import { testCatalog } from "@/lib/leads/test-catalog";
import { NextStepCard, type NextStepSource } from "./NextStepCard";

vi.mock("@/lib/ai/client", () => ({ aiClient: { nextStep: vi.fn(), apply: vi.fn(), dismiss: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const TZ = "Asia/Kolkata";
const suggestion = (over: Partial<NextStep> = {}): NextStep => ({
  summary: "Interested; wants to see the site on Saturday.",
  stageId: "s-booked",
  followUp: { at: "2026-10-24T11:00", title: "Site visit" },
  lostReasonId: null,
  tagIds: ["t-hot"],
  decisionMaker: null,
  ...over,
});
const DUE = "2026-10-24T05:30:00.000Z"; // October 24, Saturday, 11 am in Kolkata
const fromCall: NextStepSource = { activityId: "a1", kind: "call", at: "2026-10-21T10:42:00.000Z" };

function show(source: NextStepSource = fromCall) {
  const onApplied = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <NextStepCard
      leadId="l1"
      tz={TZ}
      catalog={testCatalog()}
      source={source}
      onApplied={onApplied}
      onClose={onClose}
    />,
  );
  return { onApplied, onClose, ...view };
}
const ready = () => screen.findByRole("heading", { name: "Suggested next step" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T10:00:00Z")); // Wednesday 3:30 pm in Kolkata
  vi.mocked(aiClient.nextStep).mockResolvedValue(
    ok({ read: { id: "r1", suggestion: suggestion(), dueAt: DUE } }),
  );
  vi.mocked(aiClient.dismiss).mockResolvedValue(ok({ dismissed: true as const }));
});
afterEach(() => vi.useRealTimers());

describe("the suggested next step (spec 2026-10-18 §5.2, canvas board NextStep)", () => {
  it("reads the note, then shows what it means and the three parts, each ticked", async () => {
    const { container } = show();
    expect(screen.getByText("LUME AI is reading your note…").closest("section")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(aiClient.nextStep).toHaveBeenCalledWith("l1", "a1");
    const heading = await ready();
    // It's said politely when it arrives, and focus goes to it: it's the next thing to do.
    expect(container.querySelector('[aria-live="polite"]')).toContainElement(heading);
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText("Interested; wants to see the site on Saturday.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Move to Call booked" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Follow up October 24, Saturday · 11 am Site visit" }),
    ).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Add tag Hot" })).toBeChecked();
    expect(screen.getByText("From your call at 4:12 pm")).toBeInTheDocument();
  });

  it("unticking a part sends false for it, and Apply says what was done and what wasn't", async () => {
    vi.mocked(aiClient.apply).mockResolvedValue(
      ok({
        applied: ["stage" as const],
        skipped: [{ part: "tags" as const, why: "Your role can't change tags." }],
      }),
    );
    const { onApplied } = show();
    await ready();
    await userEvent.click(screen.getByRole("checkbox", { name: /Follow up/ }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(aiClient.apply).toHaveBeenCalledWith("r1", { stage: true, followUp: false, tags: true });
    const done = await screen.findByRole("heading", { name: "Done" });
    await waitFor(() => expect(done).toHaveFocus());
    expect(screen.getByText("Moved to Call booked.")).toBeInTheDocument();
    expect(screen.getByText("The tag wasn't added. Your role can't change tags.")).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
  });

  it("Apply waits for at least one part", async () => {
    show();
    await ready();
    for (const box of screen.getAllByRole("checkbox")) await userEvent.click(box);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("Dismiss forgets it and closes the card", async () => {
    const { onClose } = show();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(aiClient.dismiss).toHaveBeenCalledWith("r1");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("Tab goes through the parts, then Apply, then Dismiss; Escape doesn't throw the suggestion away", async () => {
    show();
    await waitFor(async () => expect(await ready()).toHaveFocus());
    await userEvent.tab();
    expect(screen.getByRole("checkbox", { name: /Move to/ })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("checkbox", { name: /Follow up/ })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("checkbox", { name: /Add tag/ })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Apply" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(aiClient.dismiss).not.toHaveBeenCalled();
  });

  it("only the parts LUME AI suggested; a lost stage names its reason", async () => {
    vi.mocked(aiClient.nextStep).mockResolvedValue(
      ok({
        read: {
          id: "r1",
          suggestion: suggestion({ stageId: "s-lost", lostReasonId: "r-price", followUp: null, tagIds: [] }),
          dueAt: null,
        },
      }),
    );
    show();
    await ready();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "Move to Lost · Price" })).toBeChecked();
  });

  it("nothing to change: the summary and Dismiss, no Apply", async () => {
    vi.mocked(aiClient.nextStep).mockResolvedValue(
      ok({
        read: {
          id: "r1",
          suggestion: suggestion({ stageId: null, followUp: null, tagIds: [] }),
          dueAt: null,
        },
      }),
    );
    show();
    await ready();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("a suggestion still waiting shows at once, without another read", async () => {
    show({
      pending: {
        id: "r9",
        suggestion: suggestion(),
        dueAt: DUE,
        from: { activityId: "a1", at: "2026-10-21T09:00:00.000Z" },
      },
    });
    expect(await ready()).toBeInTheDocument();
    expect(aiClient.nextStep).not.toHaveBeenCalled();
    expect(screen.getByText("Suggested 1h ago")).toBeInTheDocument();
  });

  it("at a limit, the card says when LUME AI is back, and offers no button", async () => {
    vi.mocked(aiClient.nextStep).mockResolvedValue(
      ok({ unavailable: "limit" as const, by: "hour" as const, until: "2026-10-21T10:10:00.000Z" }),
    );
    show();
    expect(
      await screen.findByText("LUME AI has reached this hour's limit. It's back at 3:40 pm."),
    ).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("when the read fails, Try again reads it again", async () => {
    vi.mocked(aiClient.nextStep).mockResolvedValueOnce(ok({ unavailable: "failed" as const }));
    show();
    expect(await screen.findByText("LUME couldn't read this note just now.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await ready()).toBeInTheDocument();
    expect(aiClient.nextStep).toHaveBeenCalledTimes(2);
  });

  it("when LUME AI is off, there's no card at all", async () => {
    vi.mocked(aiClient.nextStep).mockResolvedValue(ok({ unavailable: "off" as const }));
    const { onClose, container } = show();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(container.querySelector("section")).toBeNull();
  });
});
