import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiClient } from "@/lib/ai/client";
import type { WaMeaning } from "@/lib/whatsapp/types";
import { ReplyMeaning } from "./ReplyMeaning";

vi.mock("@/lib/ai/client", () => ({ aiClient: { apply: vi.fn(), dismiss: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const meaning = (o: Partial<WaMeaning> = {}): WaMeaning => ({
  readId: "r1",
  group: "visit_or_call",
  summary: "Wants a site visit on Saturday at 11.",
  stop: false,
  suggestion: {
    summary: "Wants a site visit on Saturday at 11.",
    stageId: "s-visit",
    followUp: { at: "2026-10-24T11:00", title: "Site visit" },
    lostReasonId: null,
    tagIds: [],
    decisionMaker: null,
  },
  dueAt: "2026-10-24T05:30:00.000Z",
  stageName: "Site visit booked",
  lostReason: null,
  outcome: null,
  ...o,
});
const show = (m: Parameters<typeof ReplyMeaning>[0]["meaning"], onDone = vi.fn()) => {
  render(<ReplyMeaning meaning={m} from="Sneha" tz="Asia/Kolkata" onDone={onDone} />);
  return onDone;
};
beforeEach(() => vi.clearAllMocks());

/** What a reply means, under it on the thread (W2, spec 2026-10-18 §5.1, §5.4). */
describe("ReplyMeaning", () => {
  it("its group, its line, where it came from, and what LUME AI suggests", () => {
    show(meaning());
    expect(screen.getByText("Wants a visit or call")).toBeInTheDocument();
    expect(screen.getByText("Wants a site visit on Saturday at 11.")).toBeInTheDocument();
    expect(screen.getByText(/From Sneha's reply/)).toBeInTheDocument();
    expect(screen.getByText(/Move to Site visit booked/)).toBeInTheDocument();
    expect(screen.getByText(/^Follow up .* at 11 am$/)).toBeInTheDocument();
  });

  it("Apply does it as the person and says what was done; Dismiss forgets it", async () => {
    vi.mocked(aiClient.apply).mockResolvedValue(ok({ applied: ["stage", "followUp"], skipped: [] }));
    const onDone = show(meaning());
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(aiClient.apply).toHaveBeenCalledWith("r1", { stage: true, followUp: true, tags: false });
    expect(await screen.findByText(/Moved to Site visit booked and set a follow-up/)).toBeInTheDocument();
    expect(onDone).toHaveBeenCalled();
  });

  it("Dismiss: the suggestion goes; the meaning stays", async () => {
    vi.mocked(aiClient.dismiss).mockResolvedValue(ok({ dismissed: true as const }));
    show(meaning());
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(aiClient.dismiss).toHaveBeenCalledWith("r1");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.getByText("Wants a visit or call")).toBeInTheDocument();
  });

  it("a stop: said, and that LUME marked the lead do not contact; nothing to apply", () => {
    show(
      meaning({
        group: "stop",
        stop: true,
        summary: "Asks not to be messaged.",
        stageName: null,
        dueAt: null,
      }),
    );
    expect(screen.getByText("Stop messaging")).toBeInTheDocument();
    expect(screen.getByText("LUME marked Sneha do not contact.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("already applied or dismissed: no buttons; a read that failed says so once", () => {
    const { unmount } = render(
      <ReplyMeaning
        meaning={meaning({ outcome: "applied" })}
        from="Sneha"
        tz="Asia/Kolkata"
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText("Applied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    unmount();
    show({ failed: true });
    expect(screen.getByText("LUME AI couldn't read this reply.")).toBeInTheDocument();
  });

  it("nothing suggested: just the meaning", () => {
    show(
      meaning({
        group: "interested",
        stageName: null,
        dueAt: null,
        suggestion: { ...meaning().suggestion, stageId: null, followUp: null },
      }),
    );
    expect(screen.getByText("Interested")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });
});
