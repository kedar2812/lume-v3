import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { EMPTY_FILTERS } from "@/lib/leads/filters";
import { testCatalog, testLead as lead } from "@/lib/leads/test-catalog";
import { fakeSession } from "@/server/session";
import { LeadsScreen } from "./LeadsScreen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/leads",
}));
const address = () => window.location.pathname + window.location.search;
vi.mock("@/lib/leads/client", () => ({
  leadsClient: {
    list: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    activities: vi.fn(),
    remove: vi.fn(),
    create: vi.fn(),
    duplicates: vi.fn(),
  },
  PAGE_SIZE: 50,
}));
// jsdom runs no animations, so AnimatePresence would wait forever for the drawer's exit.
vi.mock("motion/react", async () => {
  const { createElement, forwardRef } = await import("react");
  const strip = ({
    initial,
    animate,
    exit,
    transition,
    layout,
    layoutId,
    ...rest
  }: Record<string, unknown>) => (
    void initial,
    void animate,
    void exit,
    void transition,
    void layout,
    void layoutId,
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
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn() }),
}));

const rep = () =>
  fakeSession({
    permissions: [
      { key: "leads.view", scope: "own" },
      { key: "leads.edit", scope: "own" },
    ],
  });
const admin = () =>
  fakeSession({
    permissions: [
      { key: "leads.view", scope: "all" },
      { key: "leads.create", scope: null },
      { key: "leads.contact.full", scope: "all" },
      { key: "leads.bulk_edit", scope: "all" },
    ],
  });

beforeEach(() => {
  vi.mocked(leadsClient.list).mockReset();
  window.history.replaceState(null, "", "/leads");
  localStorage.clear();
});

const view = (props: Partial<Parameters<typeof LeadsScreen>[0]> = {}) =>
  render(
    <LeadsScreen
      session={rep()}
      catalog={testCatalog()}
      contactsVisible={false}
      initialFilters={EMPTY_FILTERS}
      first={{ items: [lead()], nextCursor: null }}
      {...props}
    />,
  );

describe("LeadsScreen", () => {
  it("shows the first page straight away, with a masked role's table carrying no contact column at all", () => {
    view();
    expect(screen.getByRole("button", { name: "Open Aisha Khan" })).toBeInTheDocument();
    const header = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(header).toEqual(expect.arrayContaining(["Name", "Stage", "Owner"]));
    expect(header.join(" ")).not.toMatch(/Phone|Email|Instagram/);
    expect(screen.queryByRole("button", { name: /export/i })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveAttribute("placeholder", "Search by name");
  });

  it("gives a full-contact role the phone column and contact search", () => {
    view({
      session: admin(),
      contactsVisible: true,
      first: {
        items: [lead({ contactMasked: false, phone: { display: "+971 50 123 4567", masked: false } })],
        nextCursor: null,
      },
    });
    expect(screen.getByRole("columnheader", { name: "Phone" })).toBeInTheDocument();
    expect(screen.getByText("+971 50 123 4567")).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveAttribute("placeholder", "Search name, phone or email");
  });

  it("puts a filter into the address bar and fetches the matching page", async () => {
    vi.mocked(leadsClient.list).mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: [], nextCursor: null },
    });
    view();
    await userEvent.type(screen.getByRole("searchbox"), "zz");
    await vi.waitFor(() =>
      expect(leadsClient.list).toHaveBeenCalledWith(expect.objectContaining({ q: "zz" }), undefined),
    );
    expect(address()).toBe("/leads?q=zz");
    expect(await screen.findByText("Nothing matches these filters")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(address()).toBe("/leads");
  });

  it("says so when there are no leads at all, and offers to create one only to those who may", () => {
    const { unmount } = view({ first: { items: [], nextCursor: null } });
    expect(screen.getByText("No leads yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New lead" })).not.toBeInTheDocument();
    unmount();
    view({ session: admin(), first: { items: [], nextCursor: null } });
    expect(screen.getAllByRole("button", { name: "New lead" }).length).toBeGreaterThan(0);
  });

  it("loads the next page when asked, and keeps what it had", async () => {
    vi.mocked(leadsClient.list).mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: [lead({ id: "l2", name: "Omar Haddad" })], nextCursor: null },
    });
    view({ first: { items: [lead()], nextCursor: "c1" } });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(leadsClient.list).toHaveBeenCalledWith(expect.anything(), "c1");
    expect(await screen.findByRole("button", { name: "Open Omar Haddad" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Aisha Khan" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("explains a failed load and retries", async () => {
    vi.mocked(leadsClient.list)
      .mockResolvedValueOnce({ ok: false, status: 0, code: "OFFLINE", message: "offline" })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { items: [lead()], nextCursor: null } });
    view();
    await userEvent.type(screen.getByRole("searchbox"), "a");
    expect(await screen.findByText(/can’t load leads/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Open Aisha Khan" })).toBeInTheDocument();
  });

  it("ignores a slow answer to an old search once a newer one has arrived", async () => {
    let first!: (v: unknown) => void;
    vi.mocked(leadsClient.list)
      .mockImplementationOnce(() => new Promise((r) => (first = r)) as never)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { items: [lead({ id: "new", name: "Newer answer" })], nextCursor: null },
      });
    view();
    await userEvent.type(screen.getByRole("searchbox"), "a");
    await vi.waitFor(() => expect(leadsClient.list).toHaveBeenCalledTimes(1));
    await userEvent.type(screen.getByRole("searchbox"), "b");
    expect(await screen.findByRole("button", { name: "Open Newer answer" })).toBeInTheDocument();
    first({
      ok: true,
      status: 200,
      data: { items: [lead({ id: "old", name: "Stale answer" })], nextCursor: null },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Stale answer")).not.toBeInTheDocument();
  });

  it("lets a person choose and reorder columns, and remembers it", async () => {
    view({ session: admin(), contactsVisible: true });
    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    const menu = screen.getByRole("dialog", { name: "Columns" });
    await userEvent.click(within(menu).getByRole("checkbox", { name: "Email" }));
    await userEvent.click(within(menu).getByRole("button", { name: "Move Email up" }));
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.indexOf("Email")).toBeLessThan(headers.indexOf("Last activity"));
    expect(JSON.parse(localStorage.getItem(`lume.leads.columns.${admin().user.id}`)!)).toContain("email");
  });

  it("filters by a custom field from More filters", async () => {
    vi.mocked(leadsClient.list).mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: [], nextCursor: null },
    });
    view();
    await userEvent.click(screen.getByRole("button", { name: /more filters/i }));
    await userEvent.selectOptions(screen.getByLabelText("Struggles"), "o1");
    await vi.waitFor(() =>
      expect(leadsClient.list).toHaveBeenCalledWith(
        expect.objectContaining({ custom: { struggles: "o1" } }),
        undefined,
      ),
    );
    expect(address()).toBe("/leads?cf.struggles=o1");
  });

  it("edits a value in place, saving with the version it saw", async () => {
    vi.mocked(leadsClient.patch).mockResolvedValue({
      ok: true,
      status: 200,
      data: { lead: lead({ value: 5200, version: 2 }) },
    });
    view();
    await userEvent.click(screen.getByRole("button", { name: "Edit Deal value for Aisha Khan" }));
    const box = screen.getByRole("textbox", { name: "Deal value" });
    await userEvent.clear(box);
    await userEvent.type(box, "5200{Enter}");
    expect(leadsClient.patch).toHaveBeenCalledWith("l1", 1, { value: 5200 });
    expect(await screen.findByText("AED 5,200")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Deal value" })).not.toBeInTheDocument();
  });

  it("opens a lead in the drawer, keeps it in the address bar, and closes it with Escape", async () => {
    vi.mocked(leadsClient.get).mockResolvedValue({ ok: true, status: 200, data: { lead: lead() } });
    view();
    await userEvent.click(screen.getByRole("button", { name: "Open Aisha Khan" }));
    expect(await screen.findByRole("dialog", { name: "Aisha Khan" })).toBeInTheDocument();
    expect(address()).toBe("/leads?lead=l1");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(address()).toBe("/leads");
  });

  it("takes a deleted lead out of the list and closes the drawer", async () => {
    const deletable = lead({ can: { ...lead().can, delete: true } });
    vi.mocked(leadsClient.get).mockResolvedValue({ ok: true, status: 200, data: { lead: deletable } });
    vi.mocked(leadsClient.remove).mockResolvedValue({ ok: true, status: 204, data: null });
    view({ first: { items: [deletable, lead({ id: "l2", name: "Omar Farouk" })], nextCursor: null } });
    await userEvent.click(screen.getByRole("button", { name: "Open Aisha Khan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete lead" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Open Aisha Khan" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Omar Farouk" })).toBeInTheDocument();
  });

  it("adds a lead from New lead, puts it at the top, and opens it", async () => {
    const added = lead({ id: "l-new", name: "Noor Ahmed" });
    vi.mocked(leadsClient.duplicates).mockResolvedValue({ ok: true, status: 200, data: { duplicates: [] } });
    vi.mocked(leadsClient.create).mockResolvedValue({
      ok: true,
      status: 201,
      data: { lead: added, duplicates: [] },
    });
    vi.mocked(leadsClient.get).mockResolvedValue({ ok: true, status: 200, data: { lead: added } });
    view({ session: admin(), contactsVisible: true });
    await userEvent.click(screen.getAllByRole("button", { name: "New lead" })[0]!);
    const sheet = await screen.findByRole("dialog", { name: "New lead" });
    await userEvent.type(within(sheet).getByLabelText("Name"), "Noor Ahmed");
    await userEvent.click(within(sheet).getByRole("button", { name: "Create lead" }));
    expect(await screen.findByRole("dialog", { name: "Noor Ahmed" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "New lead" })).not.toBeInTheDocument();
    expect(screen.getAllByTestId("lead-row")[0]).toHaveTextContent("Noor Ahmed");
    expect(address()).toBe("/leads?lead=l-new");
  });

  it("offers no editing where the person can't edit", () => {
    view({ first: { items: [lead({ can: { ...lead().can, edit: false } })], nextCursor: null } });
    expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
  });
});
