import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { testCatalog, testLead } from "@/lib/leads/test-catalog";
import type { Lead } from "@/lib/leads/types";
import { fakeSession } from "@/server/session";
import { CatalogProvider } from "../CatalogProvider";
import { LeadDrawer } from "./LeadDrawer";

vi.mock("@/lib/leads/client", () => ({
  leadsClient: {
    get: vi.fn(),
    activities: vi.fn(),
    reveal: vi.fn(),
    move: vi.fn(),
    patch: vi.fn(),
    assign: vi.fn(),
    note: vi.fn(),
    prepareMessage: vi.fn(),
    confirmMessage: vi.fn(),
    replied: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock("@/lib/calendar/client", () => ({
  calendarClient: { leadMeetings: vi.fn(async () => ({ ok: true, status: 200, data: { meetings: [] } })) },
}));
vi.mock("@/lib/templates/client", () => ({
  templatesClient: {
    list: vi.fn(async () => ({ ok: true, status: 200, data: { templates: [] } })),
    context: vi.fn(async () => ({ ok: false, status: 403, code: "FORBIDDEN", message: "No" })),
  },
}));
const play = vi.fn();
vi.mock("@/components/feedback/SoundProvider", () => ({
  useSound: () => ({ play, enabled: true, setEnabled: vi.fn(), volume: 60, setVolume: vi.fn() }),
}));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
// jsdom runs no animations, so AnimatePresence would wait forever for an exit.
vi.mock("motion/react", async () => {
  const { createElement, forwardRef } = await import("react");
  const strip = ({ initial, animate, exit, transition, layout, ...rest }: Record<string, unknown>) => (
    void initial,
    void animate,
    void exit,
    void transition,
    void layout,
    rest
  );
  const made = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) => {
        if (!made.has(tag))
          made.set(
            tag,
            forwardRef((p: Record<string, unknown>, ref) => createElement(tag, { ...strip(p), ref })),
          );
        return made.get(tag);
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: unknown }) => children,
    useReducedMotion: () => true,
  };
});

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const handlers = () => ({ onClose: vi.fn(), onStep: vi.fn(), onChanged: vi.fn(), onGone: vi.fn() });
const rep = () => fakeSession({ permissions: [{ key: "leads.view", scope: "own" }] });
const open = (lead: Lead = testLead(), session = rep()) => {
  vi.mocked(leadsClient.get).mockResolvedValue(ok({ lead }));
  vi.mocked(leadsClient.activities).mockResolvedValue(ok({ items: [], nextCursor: null }));
  const h = handlers();
  render(
    <CatalogProvider catalog={testCatalog()}>
      <LeadDrawer id={lead.id} session={session} neighbours={["l0", lead.id, "l2"]} {...h} />
    </CatalogProvider>,
  );
  return h;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LeadDrawer", () => {
  it("opens as a labelled dialog with the stage track and the lead's place in the list", async () => {
    open();
    expect(await screen.findByRole("dialog", { name: "Aisha Khan" })).toBeInTheDocument();
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^New/ })).toHaveAttribute("aria-current", "step");
  });

  it("reveals a masked contact on request and says plainly that it was recorded", async () => {
    vi.mocked(leadsClient.reveal).mockResolvedValue(
      ok({ phone: "+971 50 123 4567", email: null, instagram: null }),
    );
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Reveal contact" }));
    expect(await screen.findByText("+971 50 123 4567")).toBeInTheDocument();
    expect(screen.getByText(/recorded in the audit log/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal contact" })).not.toBeInTheDocument();
  });

  it("leaves out what the person can't do", async () => {
    open(
      testLead({
        can: { edit: false, move: false, reveal: false, assign: false, delete: false, message: false },
      }),
    );
    await screen.findByRole("dialog", { name: "Aisha Khan" });
    for (const name of ["Reveal contact", "WhatsApp", "Won", "Lost", "Delete lead"])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^New/ })).toBeDisabled();
  });

  it("marks a lead won with the achievement chime, and only then", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue(
      ok({ lead: testLead({ stageId: "s-won", wonAt: "2026-09-25T10:00:00Z" }) }),
    );
    const h = open();
    await userEvent.click(await screen.findByRole("button", { name: "Won" }));
    await userEvent.click(await screen.findByRole("button", { name: "Mark as won" }));
    await vi.waitFor(() => expect(leadsClient.move).toHaveBeenCalledWith("l1", "s-won", {}));
    await vi.waitFor(() => expect(play).toHaveBeenCalledWith("won"));
    expect(play).toHaveBeenCalledTimes(1);
    expect(h.onChanged).toHaveBeenCalledWith(expect.objectContaining({ stageId: "s-won" }));
  });

  it("saves a changed deal value before marking it won", async () => {
    vi.mocked(leadsClient.patch).mockResolvedValue(ok({ lead: testLead({ value: 6000, version: 2 }) }));
    vi.mocked(leadsClient.move).mockResolvedValue(ok({ lead: testLead({ stageId: "s-won", value: 6000 }) }));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Won" }));
    const value = screen.getByLabelText("Deal value");
    await userEvent.clear(value);
    await userEvent.type(value, "6000");
    await userEvent.click(screen.getByRole("button", { name: "Mark as won" }));
    await vi.waitFor(() => expect(leadsClient.move).toHaveBeenCalled());
    expect(leadsClient.patch).toHaveBeenCalledWith("l1", 1, { value: 6000 });
  });

  it("closes itself with an explanation when the lead is handed to someone the person can't see", async () => {
    vi.mocked(leadsClient.assign).mockResolvedValue(ok({ id: "l1", ownerId: "u-tas", visible: false }));
    const h = open(
      testLead({ can: { ...testLead().can, assign: true } }),
      fakeSession({
        permissions: [
          { key: "leads.view", scope: "team" },
          { key: "leads.assign", scope: "team" },
        ],
      }),
    );
    await userEvent.click(await screen.findByRole("button", { name: /owner: riya sharma/i }));
    expect(screen.queryByRole("menuitem", { name: "Unassigned" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Leila Haddad" }));
    await vi.waitFor(() => expect(h.onGone).toHaveBeenCalledWith("l1", "handed"));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Handed to Leila Haddad" }));
  });

  it("explains a lead that isn't available any more instead of an error screen", async () => {
    vi.mocked(leadsClient.get).mockResolvedValue({ ok: false, status: 404, code: "NOT_FOUND", message: "x" });
    vi.mocked(leadsClient.activities).mockResolvedValue({
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "x",
    });
    render(
      <CatalogProvider catalog={testCatalog()}>
        <LeadDrawer id="gone" session={rep()} neighbours={[]} {...handlers()} />
      </CatalogProvider>,
    );
    expect(await screen.findByText(/isn’t available to you/i)).toBeInTheDocument();
  });

  it("steps through the list with J and K, and closes with Escape", async () => {
    const h = open();
    await screen.findByRole("dialog", { name: "Aisha Khan" });
    await userEvent.keyboard("j");
    expect(h.onStep).toHaveBeenCalledWith("l2");
    await userEvent.keyboard("k");
    expect(h.onStep).toHaveBeenCalledWith("l0");
    await userEvent.keyboard("{Escape}");
    expect(h.onClose).toHaveBeenCalled();
  });

  it("shows WhatsApp's own official mark on its button, never a drawn look-alike", async () => {
    open();
    const button = await screen.findByRole("button", { name: "WhatsApp" });
    const mark = button.querySelector("img");
    expect(mark).toHaveAttribute("src", "/brand/whatsapp.svg");
    expect(button.querySelector("svg")).toBeNull();
  });

  it("opens WhatsApp in a new tab from a server-built link, then asks whether it was sent", async () => {
    const tab = { location: { href: "" }, close: vi.fn(), opener: {} as unknown };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    vi.mocked(leadsClient.prepareMessage).mockResolvedValue(ok({ url: "https://wa.me/971501234567" }));
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue(ok({ moved: null }));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "WhatsApp" }));
    await userEvent.click(screen.getByRole("button", { name: "Open WhatsApp" }));
    await vi.waitFor(() => expect(tab.location.href).toBe("https://wa.me/971501234567"));
    expect(tab.opener).toBeNull();
    expect(document.body.textContent).not.toMatch(/wa\.me/); // the link itself is never shown
    window.dispatchEvent(new Event("focus"));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, sent" }));
    expect(leadsClient.confirmMessage).toHaveBeenCalledWith("l1", true, undefined);
  });

  it("the Sent prompt takes its own row under the actions, so it never covers the stage track", async () => {
    const tab = { location: { href: "" }, close: vi.fn(), opener: {} as unknown };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    vi.mocked(leadsClient.prepareMessage).mockResolvedValue(ok({ url: "https://wa.me/971501234567" }));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "WhatsApp" }));
    await userEvent.click(screen.getByRole("button", { name: "Open WhatsApp" }));
    await vi.waitFor(() => expect(tab.location.href).toBe("https://wa.me/971501234567"));
    window.dispatchEvent(new Event("focus"));
    const prompt = await screen.findByRole("group", { name: "Was the WhatsApp message sent?" });
    expect(prompt.closest("[data-sent-slot]")).not.toBeNull();
  });

  it("They replied: one tap (or R), the sent sound, and the move it made, with Undo", async () => {
    vi.mocked(leadsClient.replied).mockResolvedValue(
      ok({ moved: { stageId: "s-booked", stageName: "Call booked", fromStageId: "s-new", undoable: true } }),
    );
    vi.mocked(leadsClient.move).mockResolvedValue(ok({ lead: testLead() }));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "They replied" }));
    expect(leadsClient.replied).toHaveBeenCalledWith("l1");
    expect(play).toHaveBeenCalledWith("sent");
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "They replied · Moved to Call booked" }),
      ),
    );
    const said = toast.mock.calls.at(-1)![0] as { action: { label: string; onClick(): void } };
    expect(said.action.label).toBe("Undo");
    vi.mocked(leadsClient.get).mockResolvedValue(ok({ lead: testLead({ stageId: "s-booked" }) }));
    said.action.onClick();
    await vi.waitFor(() => expect(leadsClient.move).toHaveBeenCalledWith("l1", "s-new"));
    // The button rests a moment after each reply (a double-tap logs one), then R logs the next.
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "They replied" })).toBeEnabled(), {
      timeout: 3000,
    });
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("r");
    expect(leadsClient.replied).toHaveBeenCalledTimes(2);
  }, 8000);

  it("the reply's Undo never undoes a move made since: the lead stays, and LUME says why", async () => {
    vi.mocked(leadsClient.replied).mockResolvedValue(
      ok({ moved: { stageId: "s-booked", stageName: "Call booked", fromStageId: "s-new", undoable: true } }),
    );
    open();
    await userEvent.click(await screen.findByRole("button", { name: "They replied" }));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "They replied · Moved to Call booked" }),
      ),
    );
    const said = toast.mock.calls.at(-1)![0] as { action: { onClick(): void } };
    // Someone dragged it on meanwhile.
    vi.mocked(leadsClient.get).mockResolvedValue(ok({ lead: testLead({ stageId: "s-lost" }) }));
    said.action.onClick();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "It has moved since" })),
    );
    expect(leadsClient.move).not.toHaveBeenCalled();
  });

  it("4A review: with the send sheet open, R is just a key — no reply is logged; and holding R logs one", async () => {
    vi.mocked(leadsClient.replied).mockResolvedValue(ok({ moved: null }));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "WhatsApp" }));
    await screen.findByRole("listbox", { name: "Templates" });
    await userEvent.keyboard("r");
    expect(leadsClient.replied).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: "r", repeat: true });
    expect(leadsClient.replied).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "They replied" });
    await userEvent.dblClick(button);
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(leadsClient.replied).toHaveBeenCalledTimes(1);
  });

  it("4A review: a reply's move that moving back wouldn't undo offers no Undo", async () => {
    vi.mocked(leadsClient.replied).mockResolvedValue(
      ok({ moved: { stageId: "s-booked", stageName: "Call booked", fromStageId: "s-new", undoable: false } }),
    );
    open();
    await userEvent.click(await screen.findByRole("button", { name: "They replied" }));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "They replied · Moved to Call booked" }),
      ),
    );
    expect(toast.mock.calls.at(-1)![0]).not.toHaveProperty("action");
  });

  it("a reply the stage couldn't follow says why", async () => {
    vi.mocked(leadsClient.replied).mockResolvedValue(
      ok({ moved: null, notMoved: { code: "REQUIRED_FIELDS", message: "Fill in Package first" } }),
    );
    open();
    await userEvent.click(await screen.findByRole("button", { name: "They replied" }));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "They replied", detail: "Fill in Package first" }),
      ),
    );
  });

  it("a lost lead offers Reopen instead: the first open stage first, or any other", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue(ok({ lead: testLead({ stageId: "s-sent" }) }));
    open(testLead({ stageId: "s-lost" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reopen" }));
    expect(screen.queryByRole("button", { name: "They replied" })).not.toBeInTheDocument();
    const items = screen.getAllByRole("menuitem").map((m) => m.textContent);
    expect(items).toEqual(["New", "Message sent", "Call booked"]);
    expect(screen.getByRole("menuitem", { name: "New" })).toHaveFocus();
    await userEvent.click(screen.getByRole("menuitem", { name: "Message sent" }));
    expect(leadsClient.move).toHaveBeenCalledWith("l1", "s-sent", {});
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Reopened into Message sent" })),
    );
  });

  it("closes the blank tab and explains when WhatsApp can't be prepared", async () => {
    const tab = { location: { href: "" }, close: vi.fn(), opener: {} as unknown };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    vi.mocked(leadsClient.prepareMessage).mockResolvedValue({
      ok: false,
      status: 422,
      code: "NO_WHATSAPP_NUMBER",
      message: "This lead has no WhatsApp number",
    });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "WhatsApp" }));
    await userEvent.click(screen.getByRole("button", { name: "Open WhatsApp" }));
    await vi.waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(screen.getByText("This lead has no WhatsApp number")).toBeInTheDocument();
  });

  it("says why WhatsApp can't open for a number without a country code", async () => {
    open(testLead({ phone: { display: "05• ••• ••67", masked: true, status: "needs_country" } }));
    expect(await screen.findByRole("button", { name: "WhatsApp" })).toBeDisabled();
    expect(screen.getByText(/needs a country code/i)).toBeInTheDocument();
  });

  it("adds a note to the Notes tab", async () => {
    vi.mocked(leadsClient.note).mockResolvedValue(
      ok({
        activity: {
          id: "n1",
          type: "note",
          payload: { body: "Call after 6pm" },
          occurredAt: "2026-09-25T10:00:00Z",
          user: null,
        },
      }),
    );
    open();
    await userEvent.click(await screen.findByRole("tab", { name: "Notes" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Write a note" }), "Call after 6pm");
    await userEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(leadsClient.note).toHaveBeenCalledWith("l1", "Call after 6pm");
    expect(await screen.findByText("Call after 6pm")).toBeInTheDocument();
  });

  it("lists details without repeating the owner and stage, which have their own places", async () => {
    const cat = testCatalog();
    const core = (key: string, label: string, type: "user" | "select" | "text") => ({
      id: `f-${key}`,
      key,
      label,
      type,
      options: [],
      isCore: true,
      isRequired: false,
      archived: false,
      access: "edit" as const,
    });
    cat.fields.push(
      core("owner", "Handled by (owner)", "user"),
      core("stage", "Stage", "select"),
      core("source", "Source", "text"),
    );
    vi.mocked(leadsClient.get).mockResolvedValue(ok({ lead: testLead() }));
    render(
      <CatalogProvider catalog={cat}>
        <LeadDrawer id="l1" session={rep()} neighbours={["l1"]} {...handlers()} />
      </CatalogProvider>,
    );
    const details = await screen.findByRole("region", { name: "Details" });
    expect(details).toHaveTextContent("Deal value");
    for (const label of ["Handled by (owner)", "Stage"]) expect(details).not.toHaveTextContent(label);
  });

  it("says where a lead came from in its details", async () => {
    const cat = testCatalog();
    cat.fields.push({
      id: "f-source",
      key: "source",
      label: "Source",
      type: "text",
      options: [],
      isCore: true,
      isRequired: false,
      archived: false,
      access: "view",
    });
    vi.mocked(leadsClient.get).mockResolvedValue(ok({ lead: testLead({ sourceId: null }) }));
    render(
      <CatalogProvider catalog={cat}>
        <LeadDrawer id="l1" session={rep()} neighbours={["l1"]} {...handlers()} />
      </CatalogProvider>,
    );
    const details = await screen.findByRole("region", { name: "Details" });
    expect(details).toHaveTextContent("SourceAdded in LUME");
  });

  it("shows the history in words", async () => {
    open();
    vi.mocked(leadsClient.activities).mockResolvedValue(
      ok({
        items: [
          {
            id: "a2",
            type: "stage_changed",
            payload: { to: "s-sent" },
            occurredAt: "2026-09-25T10:00:00Z",
            user: { id: "u-tas", name: "Leila Haddad" },
          },
        ],
        nextCursor: null,
      }),
    );
    await userEvent.click(await screen.findByRole("tab", { name: "History" }));
    expect(await screen.findByText("Moved to Message sent")).toBeInTheDocument();
  });
});

describe("LeadDrawer: meetings (5D Task 11)", () => {
  it("with Calendar on, shows the next meeting and a Meetings tab with how many", async () => {
    const { calendarClient } = await import("@/lib/calendar/client");
    const soon = new Date(Date.now() + 2 * 3_600_000);
    const past = new Date(Date.now() - 48 * 3_600_000);
    const meeting = (id: string, at: Date, status = "scheduled") => ({
      id,
      title: "Discovery call",
      startsAt: at.toISOString(),
      endsAt: new Date(at.getTime() + 1_800_000).toISOString(),
      status,
      link: "https://meet.google.com/x",
      location: null,
      ownerId: "u1",
      matchedBy: "attendee",
      outcomeNote: null,
      lead: { id: "l1", name: "Aisha Khan", pipelineId: "p1", stageId: "s-new" },
    });
    vi.mocked(calendarClient.leadMeetings).mockResolvedValue({
      ok: true,
      status: 200,
      data: { meetings: [meeting("a", soon), meeting("b", past, "completed")] },
    } as never);
    const session = fakeSession({
      permissions: [
        { key: "leads.view", scope: "own" },
        { key: "calendar.view", scope: "own" },
      ],
      capabilities: { sheets: false, calendar: true },
    });
    open(testLead(), session);
    expect(await screen.findByRole("region", { name: "Next meeting" })).toHaveTextContent("Discovery call");
    const tab = screen.getByRole("tab", { name: /Meetings/ });
    expect(tab).toHaveTextContent("2");
    await userEvent.click(tab);
    expect(screen.getByRole("list", { name: "Earlier" })).toHaveTextContent("Held");
  });

  it("after J/K, a late answer for the lead before is dropped", async () => {
    const { calendarClient } = await import("@/lib/calendar/client");
    const at = new Date(Date.now() + 2 * 3_600_000);
    const meeting = (id: string, title: string, leadId: string) => ({
      id,
      title,
      startsAt: at.toISOString(),
      endsAt: new Date(at.getTime() + 1_800_000).toISOString(),
      status: "scheduled",
      link: null,
      location: null,
      ownerId: "u1",
      matchedBy: "attendee",
      outcomeNote: null,
      lead: { id: leadId, name: "Someone", pipelineId: "p1", stageId: "s-new" },
    });
    let answerFirst: (v: unknown) => void = () => {};
    vi.mocked(calendarClient.leadMeetings)
      .mockImplementationOnce(() => new Promise((r) => (answerFirst = r)) as never)
      .mockResolvedValueOnce(ok({ meetings: [meeting("b", "Pricing walkthrough", "l2")] }) as never);
    const session = fakeSession({
      permissions: [
        { key: "leads.view", scope: "own" },
        { key: "calendar.view", scope: "own" },
      ],
      capabilities: { sheets: false, calendar: true },
    });
    const first = testLead();
    const second = { ...testLead(), id: "l2" };
    vi.mocked(leadsClient.get).mockImplementation(async (id) => ok({ lead: id === "l2" ? second : first }));
    vi.mocked(leadsClient.activities).mockResolvedValue(ok({ items: [], nextCursor: null }));
    const view = (id: string) => (
      <CatalogProvider catalog={testCatalog()}>
        <LeadDrawer id={id} session={session} neighbours={[first.id, "l2"]} {...handlers()} />
      </CatalogProvider>
    );
    const { rerender } = render(view(first.id));
    rerender(view("l2"));
    expect(await screen.findByRole("region", { name: "Next meeting" })).toHaveTextContent(
      "Pricing walkthrough",
    );
    answerFirst(ok({ meetings: [meeting("a", "Old lead's call", first.id)] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("region", { name: "Next meeting" })).toHaveTextContent("Pricing walkthrough");
  });

  it("without calendar.view, no meetings are asked for or shown", async () => {
    const { calendarClient } = await import("@/lib/calendar/client");
    open();
    await screen.findByRole("dialog", { name: "Aisha Khan" });
    expect(screen.queryByRole("tab", { name: /Meetings/ })).not.toBeInTheDocument();
    expect(calendarClient.leadMeetings).not.toHaveBeenCalled();
  });
});
