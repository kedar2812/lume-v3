import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QUEUE_CHANGED, queuesClient, type QueuePlan, type QueueView } from "@/lib/queues/client";
import { templatesClient, type TemplateView } from "@/lib/templates/client";
import { ResumeRun } from "./ResumeRun";
import { StartRun } from "./StartRun";

vi.mock("@/lib/templates/client", () => ({ templatesClient: { list: vi.fn() } }));
vi.mock("@/lib/queues/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/queues/client")>()),
  queuesClient: { plan: vi.fn(), start: vi.fn(), current: vi.fn(), cancel: vi.fn() },
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const t = (id: string, name: string, category: TemplateView["category"], usable = true) =>
  ({
    id,
    name,
    category,
    body: `${name} words`,
    allowedRoleIds: [],
    versionId: `v-${id}`,
    version: 1,
    position: 0,
    updatedAt: "2026-09-29T10:00:00Z",
    usable,
  }) satisfies TemplateView;
const TEMPLATES = [
  t("t1", "First hello", "first_touch"),
  t("t2", "Gentle nudge", "follow_up"),
  t("t4", "Come back", "re_engagement"),
  t("t5", "Partners only", "custom", false),
];
const PLAN: QueuePlan = {
  total: 40,
  leftOut: [
    { name: "Aisha Khan", reason: "No WhatsApp number" },
    { name: "Omar Ali", reason: "The number needs a country code" },
    { name: "Sara Nasser", reason: "No WhatsApp number" },
  ],
  more: 2,
  today: { sent: 37, cap: 150 },
  open: null,
};
const RUN: QueueView = {
  id: "q9",
  status: "paused",
  pausedReason: null,
  templateName: "Gentle nudge",
  sourceName: "No reply 3+ days",
  total: 40,
  done: { sent: 9, notSent: 1, skipped: 2 },
  today: { sent: 9, cap: 150 },
  items: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(templatesClient.list).mockResolvedValue(ok({ templates: TEMPLATES }));
  vi.mocked(queuesClient.plan).mockResolvedValue(ok(PLAN));
  vi.mocked(queuesClient.start).mockResolvedValue(
    ok({ queue: { ...RUN, id: "q1", status: "active" }, leftOut: [], more: 0 }),
  );
});

const open = async (props: Partial<Parameters<typeof StartRun>[0]> = {}) => {
  render(<StartRun source={{ viewId: "v1" }} {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Message these" }));
  const dialog = screen.getByRole("dialog", { name: "Start a send queue" });
  await within(dialog).findByText("40 leads");
  return dialog;
};
const names = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole("radio")
    .map((o) => o.getAttribute("data-name"));

describe("StartRun (4C Task 3)", () => {
  it("says who'd be in, today's count, and offers the view's kind of template first", async () => {
    const dialog = await open({ suggest: "re_engagement" });
    expect(queuesClient.plan).toHaveBeenCalledWith({ viewId: "v1" });
    expect(names(dialog)).toEqual(["Come back", "First hello", "Gentle nudge", "Your own words"]);
    expect(within(dialog).getByRole("radio", { name: /Come back/ })).toBeChecked();
    expect(within(dialog).getByText("2 more wait for the next run")).toBeInTheDocument();
    expect(within(dialog).getByText("37 / 150")).toBeInTheDocument();
  });

  it("a template's line reads as words, its variables as named chips", async () => {
    vi.mocked(templatesClient.list).mockResolvedValue(
      ok({ templates: [{ ...t("t9", "Hello", "first_touch"), body: "Hi {{lead.first_name}}, welcome" }] }),
    );
    const dialog = await open();
    const option = within(dialog).getByRole("radio", { name: /Hello/ }).closest("label")!;
    expect(option).not.toHaveTextContent("{{");
    expect(option).toHaveTextContent("First name");
  });

  it("the left-out reasons are one tap away", async () => {
    const dialog = await open();
    const reasons = within(dialog).getByRole("button", { name: "3 left out" });
    expect(reasons).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByText("Omar Ali")).not.toBeInTheDocument();
    await userEvent.click(reasons);
    expect(reasons).toHaveAttribute("aria-expanded", "true");
    const list = within(dialog).getByRole("list", { name: "Left out" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Aisha KhanNo WhatsApp number",
      "Omar AliThe number needs a country code",
      "Sara NasserNo WhatsApp number",
    ]);
  });

  it("Start makes the run from the view, with the chosen template, and opens it", async () => {
    const changed = vi.fn();
    window.addEventListener(QUEUE_CHANGED, changed);
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Gentle nudge/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    expect(queuesClient.start).toHaveBeenCalledWith({ viewId: "v1" }, "t2");
    expect(push).toHaveBeenCalledWith("/queue/q1");
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(QUEUE_CHANGED, changed);
  });

  it("from a selection, in the person's own words", async () => {
    render(<StartRun source={{ leadIds: ["l2", "l1"] }} label="Message" />);
    await userEvent.click(screen.getByRole("button", { name: "Message" }));
    const dialog = screen.getByRole("dialog", { name: "Start a send queue" });
    await within(dialog).findByText("40 leads");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Your own words/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    expect(queuesClient.start).toHaveBeenCalledWith({ leadIds: ["l2", "l1"] }, undefined);
  });

  it("with a run already open: finish or end it first, and Resume takes you there", async () => {
    vi.mocked(queuesClient.plan).mockResolvedValue(
      ok({
        ...PLAN,
        open: { id: "q9", status: "paused", sourceName: "No reply 3+ days", done: 12, total: 40 },
      }),
    );
    const dialog = await open();
    expect(within(dialog).getByText("Finish or end your current run first")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Resume · 12 of 40" })).toHaveAttribute(
      "href",
      "/queue/q9",
    );
  });

  it("final review #2: the run left open can be ended right here, and then this one starts", async () => {
    vi.mocked(queuesClient.plan)
      .mockResolvedValueOnce(
        ok({
          ...PLAN,
          open: { id: "q9", status: "paused", sourceName: "No reply 3+ days", done: 12, total: 40 },
        }),
      )
      .mockResolvedValue(ok(PLAN));
    vi.mocked(queuesClient.cancel).mockResolvedValue(ok({ ...RUN, status: "cancelled" }));
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "End that run" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Sure? End it" }));
    expect(queuesClient.cancel).toHaveBeenCalledWith("q9");
    expect(await within(dialog).findByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("says why when Start is refused, and when nothing can be sent", async () => {
    vi.mocked(queuesClient.start).mockResolvedValue({
      ok: false,
      status: 409,
      code: "QUEUE_OPEN",
      message: "Finish or end your current run first",
    });
    let dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Finish or end your current run first");
    expect(push).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    vi.mocked(queuesClient.plan).mockResolvedValue(ok({ ...PLAN, total: 0, more: 0 }));
    await userEvent.click(screen.getByRole("button", { name: "Message these" }));
    dialog = screen.getByRole("dialog", { name: "Start a send queue" });
    await within(dialog).findByText("None of these can get a WhatsApp message");
    expect(within(dialog).getByRole("button", { name: "Start" })).toBeDisabled();
  });
});

describe("ResumeRun (4C Task 3)", () => {
  it("a run left open: Resume · how far it got, and it looks again when a run changes", async () => {
    vi.mocked(queuesClient.current).mockResolvedValueOnce(ok(null)).mockResolvedValueOnce(ok(RUN));
    render(<ResumeRun variant="pill" />);
    await act(async () => {});
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    await act(async () => {
      window.dispatchEvent(new Event(QUEUE_CHANGED));
    });
    expect(await screen.findByRole("link", { name: "Resume · 12 of 40" })).toHaveAttribute(
      "href",
      "/queue/q9",
    );
  });

  it("on Today, where it came from and why it's paused", async () => {
    vi.mocked(queuesClient.current).mockResolvedValue(ok({ ...RUN, pausedReason: "daily_cap" }));
    render(<ResumeRun variant="card" />);
    const card = await screen.findByRole("region", { name: "Your send queue" });
    expect(card).toHaveTextContent("No reply 3+ days");
    expect(card).toHaveTextContent("Paused until tomorrow: today's 150 are sent");
    expect(within(card).getByRole("link", { name: "Resume · 12 of 40" })).toHaveAttribute(
      "href",
      "/queue/q9",
    );
  });

  it("from a view with changes not saved: it plans what's shown", async () => {
    const { StartRun } = await import("./StartRun");
    vi.mocked(queuesClient.plan).mockResolvedValue(ok(PLAN));
    render(<StartRun source={{ viewId: "v1", filters: { noReplyDays: "7" } }} />);
    await userEvent.click(screen.getByRole("button", { name: "Message these" }));
    await vi.waitFor(() =>
      expect(queuesClient.plan).toHaveBeenCalledWith({ viewId: "v1", filters: { noReplyDays: "7" } }),
    );
  });
});
