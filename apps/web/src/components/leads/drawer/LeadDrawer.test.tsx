import { render, screen } from "@testing-library/react";
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
    remove: vi.fn(),
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
    await userEvent.click(screen.getByRole("menuitem", { name: "Tasneem Shaikh" }));
    await vi.waitFor(() => expect(h.onGone).toHaveBeenCalledWith("l1", "handed"));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Handed to Tasneem Shaikh" }));
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

  it("opens WhatsApp in a new tab from a server-built link, then asks whether it was sent", async () => {
    const tab = { location: { href: "" }, close: vi.fn(), opener: {} as unknown };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    vi.mocked(leadsClient.prepareMessage).mockResolvedValue(ok({ url: "https://wa.me/971501234567" }));
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue({ ok: true, status: 204, data: null });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "WhatsApp" }));
    await userEvent.click(screen.getByRole("button", { name: "Open WhatsApp" }));
    await vi.waitFor(() => expect(tab.location.href).toBe("https://wa.me/971501234567"));
    expect(tab.opener).toBeNull();
    expect(document.body.textContent).not.toMatch(/wa\.me/); // the link itself is never shown
    window.dispatchEvent(new Event("focus"));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, sent" }));
    expect(leadsClient.confirmMessage).toHaveBeenCalledWith("l1", true);
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
            user: { id: "u-tas", name: "Tasneem Shaikh" },
          },
        ],
        nextCursor: null,
      }),
    );
    await userEvent.click(await screen.findByRole("tab", { name: "History" }));
    expect(await screen.findByText("Moved to Message sent")).toBeInTheDocument();
  });
});
