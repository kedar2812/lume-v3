import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AUTOPILOT_PRESETS } from "@lume/core/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { autopilotClient } from "@/lib/autopilot/client";
import type { AutopilotSetup } from "@/lib/autopilot/types";
import { leadsClient } from "@/lib/leads/client";
import type { Lead } from "@/lib/leads/types";
import { pipelinesClient } from "@/lib/settings/pipelines";
import { whatsappClient } from "@/lib/whatsapp/client";
import { WaitingWork } from "./WaitingWork";

vi.mock("@/lib/autopilot/client", () => ({ autopilotClient: { setup: vi.fn() } }));
vi.mock("@/lib/leads/client", () => ({ leadsClient: { list: vi.fn() } }));
vi.mock("@/lib/settings/pipelines", () => ({ pipelinesClient: { list: vi.fn() } }));
vi.mock("@/lib/whatsapp/client", () => ({ whatsappClient: { templateState: vi.fn() } }));
vi.mock("@/components/ZoneProvider", () => ({ useZone: () => "Asia/Kolkata" }));
// The start sheet is its own (tested on its own): here, only what it's opened with.
const sheet = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("./StartSheet", () => ({
  StartSheet: (p: Record<string, unknown>) => {
    sheet.props = p;
    return <div role="dialog" aria-label="Let LUME AI handle these" />;
  },
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const lead = (id: string, name: string, o: Partial<Lead> = {}): Lead =>
  ({
    id,
    name,
    pipelineId: "p1",
    stageId: "s1",
    lastMessageAt: "2026-10-21T06:00:00.000Z",
    createdAt: "2026-10-01T06:00:00.000Z",
    updatedAt: "2026-10-21T06:00:00.000Z",
    tagIds: [],
    custom: {},
    contactMasked: false,
    ...o,
  }) as Lead;
const setup = (o: Partial<AutopilotSetup> = {}): AutopilotSetup =>
  ({
    ready: { ok: true },
    goals: [],
    speakers: [],
    standing: {
      permissions: AUTOPILOT_PRESETS.balanced,
      followUpDays: [2, 5],
      dailyCap: null,
      speaker: null,
    },
    available: {},
    hours: { line: "" },
    number: null,
    canRemember: true,
    ...o,
  }) as AutopilotSetup;
const three = [lead("a", "Meera Iyer"), lead("b", "Rohan Gupta"), lead("c", "Anika Rao")];

beforeEach(() => {
  vi.resetAllMocks();
  sheet.props = null;
  vi.mocked(leadsClient.list).mockResolvedValue(ok({ items: three, nextCursor: null }));
  vi.mocked(pipelinesClient.list).mockResolvedValue(
    ok({
      pipelines: [
        {
          id: "p1",
          name: "Sales",
          isDefault: true,
          bookingStageId: null,
          stages: [{ id: "s1", name: "New enquiry" }],
        },
      ],
    }) as never,
  );
  vi.mocked(autopilotClient.setup).mockResolvedValue(ok(setup()));
  vi.mocked(whatsappClient.templateState).mockResolvedValue(
    ok({
      number: { id: "n1", display: "+91 90000 00001" },
      options: [{ preview: "Hi Meera, you asked about a kitchen. Shall we talk?", missing: [] }],
      reason: null,
    }) as never,
  );
});

/** LUME AI's first visit (plan 2026-10-28, artboard 4): the work that's waiting, never a pitch. */
describe("WaitingWork", () => {
  it("the leads waiting on a follow-up, the first message one of them gets, what LUME AI may do, and one button", async () => {
    render(<WaitingWork canStart onStarted={vi.fn()} />);
    expect(
      await screen.findByRole("heading", { name: "3 leads haven't heard from you in 3 days or more" }),
    ).toBeInTheDocument();
    expect(leadsClient.list).toHaveBeenCalledWith(
      expect.objectContaining({ noReplyDays: 3 }),
      undefined,
      100,
    );
    const table = screen.getByRole("table", { name: "Leads waiting" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByRole("row", { name: /Meera Iyer/ })).toHaveTextContent("New enquiry");
    expect(
      await screen.findByText("Hi Meera, you asked about a kitchen. Shall we talk?"),
    ).toBeInTheDocument();
    const may = screen.getByRole("region", { name: "What it may do" });
    expect(may).toHaveTextContent("Reply and keep the conversation goingGo ahead");
    expect(may).toHaveTextContent("Answer price questionsAsk me");
    expect(screen.getByRole("button", { name: "Follow up with these 3" })).toBeEnabled();
  });

  it("untick anyone you'd rather call yourself: the button and the start sheet leave them out", async () => {
    render(<WaitingWork canStart onStarted={vi.fn()} />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Rohan Gupta" }));
    await userEvent.click(screen.getByRole("button", { name: "Follow up with these 2" }));
    expect(screen.getByRole("dialog", { name: "Let LUME AI handle these" })).toBeInTheDocument();
    expect(sheet.props).toMatchObject({ count: 2, target: { leadIds: ["a", "c"] } });
  });

  it("another choice of leads reads them again: new today", async () => {
    render(<WaitingWork canStart onStarted={vi.fn()} />);
    await screen.findByRole("table", { name: "Leads waiting" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Show" }), "new");
    await waitFor(() =>
      expect(leadsClient.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ createdDays: 1 }),
        undefined,
        100,
      ),
    );
    expect(await screen.findByRole("heading", { name: "3 leads came in today" })).toBeInTheDocument();
  });

  it("nobody waiting: says so, with where to choose leads", async () => {
    vi.mocked(leadsClient.list).mockResolvedValue(ok({ items: [], nextCursor: null }));
    render(<WaitingWork canStart onStarted={vi.fn()} />);
    expect(await screen.findByText("Nobody here is waiting on a follow-up.")).toBeInTheDocument();
    // Never "0 leads haven't heard from you".
    expect(screen.getByRole("heading", { name: "Leads waiting on you" })).toBeInTheDocument();
    expect(screen.queryByText(/^0 /)).toBeNull();
    expect(screen.queryByText("Untick anyone you'd rather call yourself.")).toBeNull();
    expect(screen.getByRole("link", { name: "Choose leads on Leads" })).toHaveAttribute("href", "/leads");
    expect(screen.queryByRole("button", { name: /Follow up with/ })).toBeNull();
  });

  it("LUME AI can't start yet (no number, no template): why, and where to fix it, instead of the button", async () => {
    vi.mocked(autopilotClient.setup).mockResolvedValue(
      ok(
        setup({
          ready: {
            ok: false,
            code: "NO_TEMPLATES",
            message: "No approved WhatsApp template yet.",
            fixHref: "/templates",
          },
        }),
      ),
    );
    render(<WaitingWork canStart onStarted={vi.fn()} />);
    expect(await screen.findByText("No approved WhatsApp template yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fix it" })).toHaveAttribute("href", "/templates");
    expect(screen.queryByRole("button", { name: /Follow up with/ })).toBeNull();
  });

  it("someone who may not start a run sees the work, without the button", async () => {
    render(<WaitingWork canStart={false} onStarted={vi.fn()} />);
    await screen.findByRole("table", { name: "Leads waiting" });
    expect(screen.queryByRole("button", { name: /Follow up with/ })).toBeNull();
    expect(screen.getByText("Someone who may message leads in bulk can start it.")).toBeInTheDocument();
  });

  it("more than a page waiting: says so honestly, and the selection still covers them all", async () => {
    vi.mocked(leadsClient.list).mockResolvedValue(ok({ items: three, nextCursor: "more" }));
    render(<WaitingWork canStart onStarted={vi.fn()} />);
    expect(
      await screen.findByRole("heading", {
        name: "3 or more leads haven't heard from you in 3 days or more",
      }),
    ).toBeInTheDocument();
  });
});
