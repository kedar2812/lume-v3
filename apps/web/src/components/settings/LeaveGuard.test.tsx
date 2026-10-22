import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLeaveGuard } from "./LeaveGuard";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function Form({ dirty }: { dirty: boolean }) {
  const sheet = useLeaveGuard(dirty);
  return (
    <>
      <a href="/leads">Leads</a>
      <a href="https://example.com/help" target="_blank" rel="noreferrer">
        Help
      </a>
      {sheet}
    </>
  );
}

beforeEach(() => vi.clearAllMocks());

/** Owner ruling 2026-10-18 (1): a Settings form with unsaved changes asks before LUME leaves it. */
describe("Leave without saving?", () => {
  it("nothing changed: a link just goes", async () => {
    render(<Form dirty={false} />);
    await userEvent.click(screen.getByRole("link", { name: "Leads" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("changes waiting: a link asks first; Keep editing stays, Leave without saving goes", async () => {
    render(<Form dirty />);
    await userEvent.click(screen.getByRole("link", { name: "Leads" }));
    const sheet = screen.getByRole("dialog", { name: "Leave without saving?" });
    expect(sheet).toHaveTextContent("Your changes on this page haven't been saved.");
    expect(push).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(push).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("link", { name: "Leads" }));
    await userEvent.click(screen.getByRole("button", { name: "Leave without saving" }));
    expect(push).toHaveBeenCalledWith("/leads");
  });

  it("a link that opens elsewhere (a new tab) never asks", async () => {
    render(<Form dirty />);
    await userEvent.click(screen.getByRole("link", { name: "Help" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closing or reloading the tab asks the browser's way, only with changes waiting", () => {
    const { rerender } = render(<Form dirty />);
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    rerender(<Form dirty={false} />);
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });
});
