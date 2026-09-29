import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_FILTERS } from "@/lib/leads/filters";
import { testCatalog } from "@/lib/leads/test-catalog";
import { VIEWS_CHANGED, viewsClient, type ViewView } from "@/lib/views/client";
import { SaveView } from "./SaveView";
import { SidebarViews } from "./SidebarViews";

vi.mock("@/lib/views/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/views/client")>()),
  viewsClient: {
    list: vi.fn(),
    counts: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    restore: vi.fn(),
    order: vi.fn(),
  },
}));
let leadsChanged: (() => void) | null = null;
vi.mock("@/lib/notifications/stream", () => ({
  useLeadsChanged: (fn: () => void) => void (leadsChanged = fn),
}));
let search = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/leads",
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
let reduce = false;
vi.mock("motion/react", async (orig) => ({
  ...(await orig<typeof import("motion/react")>()),
  useReducedMotion: () => reduce,
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const v = (id: string, name: string, o: Partial<ViewView> = {}): ViewView => ({
  id,
  name,
  color: "accent",
  filters: {},
  sharedRoleIds: [],
  shared: false,
  mine: true,
  canEdit: true,
  ...o,
});
const VIEWS = [
  v("v1", "My overdue", { color: "danger", filters: { ownerId: "me", followUpOverdue: "true" } }),
  v("v2", "No reply 3+ days", { color: "warn", filters: { noReplyDays: "3" } }),
  v("v3", "Team pipeline", { shared: true, mine: false, canEdit: false, sharedRoleIds: ["r-sales"] }),
];
const ROLES = [
  { id: "r-sales", name: "Sales" },
  { id: "r-admin", name: "Admin" },
];

beforeEach(() => {
  vi.clearAllMocks();
  search = "";
  reduce = false;
  vi.mocked(viewsClient.list).mockResolvedValue(ok({ views: VIEWS }) as never);
  vi.mocked(viewsClient.counts).mockResolvedValue(ok({ counts: { v1: 4, v2: 12, v3: null } }) as never);
  vi.mocked(viewsClient.order).mockImplementation(async () => ok({ views: VIEWS }) as never);
});

const sidebar = async () => {
  render(<SidebarViews />);
  return screen.findByRole("list", { name: "Views" });
};

describe("the Views section (4B Task 6)", () => {
  it("lists each view with its dot, name and live count ('—' where it can't be counted); each opens its list", async () => {
    search = "view=v2";
    const list = await sidebar();
    const links = within(list).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["My overdue4", "No reply 3+ days12", "Team pipeline—"]);
    expect(links[0]).toHaveAttribute("href", "/leads?view=v1");
    expect(links[1]).toHaveAttribute("aria-current", "page");
    expect(within(links[2]!).getByText("—")).toHaveAttribute("title", "LUME can't count this view any more");
  });

  it("leads changing elsewhere refreshes the counts, once for a burst", async () => {
    await sidebar();
    await vi.waitFor(() => expect(viewsClient.counts).toHaveBeenCalledTimes(1));
    act(() => {
      leadsChanged!();
      leadsChanged!();
      leadsChanged!();
    });
    await vi.waitFor(() => expect(viewsClient.counts).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 400));
    expect(viewsClient.counts).toHaveBeenCalledTimes(2);
  });

  it("a view saved anywhere arrives in the sidebar", async () => {
    await sidebar();
    vi.mocked(viewsClient.list).mockResolvedValue(ok({ views: [...VIEWS, v("v4", "Chase list")] }) as never);
    act(() => void window.dispatchEvent(new Event(VIEWS_CHANGED)));
    expect(await screen.findByRole("link", { name: /Chase list/ })).toBeInTheDocument();
  });

  it("Alt+↓ on a view's handle moves it down, and saves the person's own order", async () => {
    const list = await sidebar();
    const handle = within(list).getByRole("button", { name: "Move My overdue" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowDown", altKey: true });
    expect(viewsClient.order).toHaveBeenCalledWith(["v2", "v1", "v3"]);
  });

  it("a view only shared with you can't be edited from here", async () => {
    const list = await sidebar();
    expect(within(list).getByRole("button", { name: "Edit My overdue" })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Edit Team pipeline" })).not.toBeInTheDocument();
  });

  it("edit: rename and recolour; delete goes at once, with Undo", async () => {
    vi.mocked(viewsClient.update).mockImplementation(
      async (id, b) => ok({ ...VIEWS.find((x) => x.id === id)!, ...b }) as never,
    );
    vi.mocked(viewsClient.remove).mockResolvedValue(ok(null) as never);
    vi.mocked(viewsClient.restore).mockResolvedValue(ok(VIEWS[1]!) as never);
    const list = await sidebar();
    await userEvent.click(within(list).getByRole("button", { name: "Edit My overdue" }));
    const form = screen.getByRole("dialog", { name: "Edit My overdue" });
    const name = within(form).getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Overdue");
    await userEvent.click(within(form).getByRole("radio", { name: "Green" }));
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(viewsClient.update).toHaveBeenCalledWith("v1", { name: "Overdue", color: "ok" });

    await userEvent.click(within(list).getByRole("button", { name: "Edit No reply 3+ days" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete view" }));
    expect(viewsClient.remove).toHaveBeenCalledWith("v2");
    await vi.waitFor(() =>
      expect(within(list).queryByRole("link", { name: /No reply 3\+ days/ })).not.toBeInTheDocument(),
    );
    const said = toast.mock.calls.at(-1)![0] as { title: string; action: { label: string; onClick(): void } };
    expect(said.title).toBe("Deleted “No reply 3+ days”");
    said.action.onClick();
    expect(viewsClient.restore).toHaveBeenCalledWith("v2");
  });

  it("with Reduce Motion the section is the same, without the slides", async () => {
    reduce = true;
    const list = await sidebar();
    expect(within(list).getAllByRole("link")).toHaveLength(3);
  });
});

describe("Save view (4B Task 6)", () => {
  const catalog = testCatalog();
  const filters = { ...EMPTY_FILTERS, noReplyDays: 3, owner: "me" as const };

  it("Just me: saves the filters as they stand, focused on the name, and tells the sidebar", async () => {
    vi.mocked(viewsClient.create).mockResolvedValue(ok(v("v9", "Chase list")) as never);
    const heard = vi.fn();
    window.addEventListener(VIEWS_CHANGED, heard);
    const onSaved = vi.fn();
    render(<SaveView filters={filters} catalog={catalog} canShare={false} onSaved={onSaved} />);
    await userEvent.click(screen.getByRole("button", { name: "Save view" }));
    const form = screen.getByRole("dialog", { name: "Save view" });
    expect(within(form).getByRole("textbox", { name: "Name" })).toHaveFocus();
    expect(within(form).queryByRole("radio", { name: "Share with roles" })).not.toBeInTheDocument();
    await userEvent.keyboard("Chase list{Enter}");
    expect(viewsClient.create).toHaveBeenCalledWith({
      name: "Chase list",
      color: "accent",
      filters: expect.objectContaining({ noReplyDays: "3", ownerId: "me" }),
    });
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "v9" })));
    expect(heard).toHaveBeenCalled();
    window.removeEventListener(VIEWS_CHANGED, heard);
  });

  it("someone who manages views can share it with roles", async () => {
    vi.mocked(viewsClient.list).mockResolvedValue(ok({ views: VIEWS, roles: ROLES }) as never);
    vi.mocked(viewsClient.create).mockResolvedValue(ok(v("v9", "Team chase", { shared: true })) as never);
    render(<SaveView filters={filters} catalog={catalog} canShare onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Save view" }));
    const form = screen.getByRole("dialog", { name: "Save view" });
    await userEvent.type(within(form).getByRole("textbox", { name: "Name" }), "Team chase");
    await userEvent.click(within(form).getByRole("radio", { name: "Share with roles" }));
    await userEvent.click(await within(form).findByRole("checkbox", { name: "Sales" }));
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(viewsClient.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Team chase", sharedRoleIds: ["r-sales"] }),
    );
  });
});
