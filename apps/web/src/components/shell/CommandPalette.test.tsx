import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { templatesClient } from "@/lib/templates/client";
import { viewsClient } from "@/lib/views/client";
import { CommandPalette, Marked } from "./CommandPalette";

const go = vi.fn();
vi.mock("./PageTransition", () => ({ usePageNav: () => ({ go }) }));
vi.mock("@/lib/leads/client", () => ({ leadsClient: { list: vi.fn() } }));
vi.mock("@/lib/views/client", () => ({ viewsClient: { list: vi.fn() } }));
vi.mock("@/lib/templates/client", () => ({ templatesClient: { list: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const lead = (id: string, name: string, phone: string) =>
  ({ id, name, phone: { display: phone, masked: false }, tagIds: [], custom: {} }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(leadsClient.list).mockResolvedValue(ok({ items: [], nextCursor: null }) as never);
  vi.mocked(viewsClient.list).mockResolvedValue(
    ok({ views: [{ id: "v1", name: "Hot this week" }] }) as never,
  );
  vi.mocked(templatesClient.list).mockResolvedValue(
    ok({ templates: [{ id: "t1", name: "Gentle nudge", category: "follow_up" }] }) as never,
  );
});
const typeIn = async (v: string) => userEvent.type(screen.getByRole("combobox"), v);

describe("Search LUME (Ctrl K)", () => {
  it("finds leads by name, phone or email as you type; Enter opens the lead and remembers it", async () => {
    vi.mocked(leadsClient.list).mockResolvedValue(
      ok({ items: [lead("l1", "Kedar Mehta", "+91 98200 11111")], nextCursor: null }) as never,
    );
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} can={() => true} />);
    await typeIn("kedar");
    const leads = await screen.findByRole("group", { name: "Leads" });
    expect(within(leads).getByRole("option", { name: /Kedar Mehta/ })).toHaveTextContent("+91 98200 11111");
    expect(vi.mocked(leadsClient.list).mock.calls.at(-1)![0]).toMatchObject({ q: "kedar" });
    await userEvent.keyboard("{Enter}");
    expect(go).toHaveBeenCalledWith("/leads?lead=l1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(JSON.parse(localStorage.getItem("lume:recent-leads")!)[0]).toMatchObject({
      id: "l1",
      name: "Kedar Mehta",
    });
  });

  it("empty, it offers the leads opened lately, things to do, and the pages", async () => {
    localStorage.setItem("lume:recent-leads", JSON.stringify([{ id: "l9", name: "Asha Rao" }]));
    render(<CommandPalette open onOpenChange={() => undefined} can={() => true} />);
    expect(screen.getByRole("group", { name: "Recent" })).toHaveTextContent("Asha Rao");
    expect(screen.getByRole("group", { name: "Actions" })).toHaveTextContent("New lead");
    expect(screen.getByRole("group", { name: "Go to" })).toHaveTextContent("Analytics");
  });

  it("pages, actions, views, settings and templates by a few letters, even with a typo", async () => {
    render(<CommandPalette open onOpenChange={() => undefined} can={() => true} />);
    await typeIn("watermrk");
    expect(await screen.findByRole("option", { name: /On-screen watermark/ })).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("combobox"));
    await typeIn("hot");
    expect(await screen.findByRole("option", { name: /Hot this week/ })).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("combobox"));
    await typeIn("import");
    await userEvent.click(await screen.findByRole("option", { name: /Import leads/ }));
    expect(go).toHaveBeenCalledWith("/leads?do=import");
  });

  it("never offers what the role can't open, nor looks up leads without leads.view", async () => {
    render(<CommandPalette open onOpenChange={() => undefined} can={(p) => p === "analytics.view"} />);
    expect(screen.queryByRole("option", { name: /^Leads$/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /New lead/ })).toBeNull();
    await typeIn("kedar");
    await new Promise((r) => setTimeout(r, 300));
    expect(leadsClient.list).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Nothing matches “kedar”.");
  });

  it("moves the selection with the arrow keys", async () => {
    render(<CommandPalette open onOpenChange={() => undefined} can={() => true} />);
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  });
});

describe("where a search matched", () => {
  it("marks the typed letters in the result, whatever their case; nothing under two letters", () => {
    const { container, rerender } = render(<Marked text="Anika Haddad" query="had" />);
    expect(container.querySelector("mark")?.textContent).toBe("Had");
    rerender(<Marked text="Anika Haddad" query="a" />);
    expect(container.querySelector("mark")).toBeNull();
  });
});
