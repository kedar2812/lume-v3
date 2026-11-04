import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_WHATS_NEW } from "@lume/core/shared";
import { WhatsNewProvider } from "@/components/whats-new/WhatsNewProvider";
import { fakeSession } from "@/server/session";
import { MobileTabs } from "./MobileTabs";

vi.mock("next/navigation", () => ({ usePathname: () => "/templates", useRouter: () => ({ push: vi.fn() }) }));

describe("the phone's tab bar (canvas Phone)", () => {
  it("Today, Leads, Calendar and Settings at hand; the rest under More, which marks where you are", async () => {
    render(<MobileTabs can={() => true} />);
    const bar = screen.getByRole("navigation", { name: "Tabs" });
    expect(
      within(bar)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Today", "Leads", "Calendar", "Settings"]);
    const more = within(bar).getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("data-on");
    await userEvent.click(more);
    const menu = screen.getByRole("menu", { name: "More" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((l) => l.textContent),
    ).toEqual(["Who replied", "LUME AI", "Pipeline", "Templates", "Media", "Analytics"]);
    expect(within(menu).getByRole("menuitem", { name: "Templates" })).toHaveAttribute("aria-current", "page");
  });

  it("only what the person may open", () => {
    render(<MobileTabs can={(p) => p === "leads.view"} />);
    const bar = screen.getByRole("navigation", { name: "Tabs" });
    expect(
      within(bar)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Today", "Leads", "Settings"]);
    expect(within(bar).getByRole("button", { name: "More" })).toBeInTheDocument();
  });
});

describe("Send feedback on a phone (spec 2026-10-16 §1.1)", () => {
  it("is the last thing in More, after a divider", async () => {
    const onFeedback = vi.fn();
    render(<MobileTabs can={() => true} onFeedback={onFeedback} />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: "More" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.at(-1)).toHaveTextContent("Send feedback");
    expect(within(menu).getByRole("separator")).toBeInTheDocument();
    await userEvent.click(items.at(-1)!);
    expect(onFeedback).toHaveBeenCalledTimes(1);
  });

  it("keeps More for it even when everything else fits in the bar", async () => {
    render(<MobileTabs can={(p) => p === "leads.view"} onFeedback={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Send feedback" })).toBeInTheDocument();
  });

  it("isn't there without somewhere to send it", async () => {
    render(<MobileTabs can={() => true} />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Send feedback" })).toBeNull();
  });

  it("New on what's new under More, and a dot on More itself (spec 2026-11-02)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));
    const session = fakeSession({
      whatsNew: { version: "1.2.0", stories: ["chats"], state: { ...EMPTY_WHATS_NEW, seen: "1.2.0" } },
    });
    render(
      <WhatsNewProvider session={session} client={{ save: vi.fn(async () => null) }}>
        <MobileTabs can={() => true} />
      </WhatsNewProvider>,
    );
    const more = screen.getByRole("button", { name: "More" });
    expect(more.querySelector("[data-new]")).not.toBeNull();
    await userEvent.click(more);
    const menu = screen.getByRole("menu", { name: "More" });
    expect(within(menu).getByRole("menuitem", { name: /Who replied/ })).toHaveTextContent("New");
    expect(within(menu).getByRole("menuitem", { name: /Pipeline/ })).not.toHaveTextContent("New");
    vi.useRealTimers();
  });
});
