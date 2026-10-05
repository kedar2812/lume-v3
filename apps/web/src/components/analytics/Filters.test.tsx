import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsClient } from "@/lib/analytics/client";
import { testCatalog } from "@/lib/leads/test-catalog";
import { FilterChips, FiltersButton } from "./Filters";

vi.mock("@/lib/analytics/client", async (orig) => {
  const real = await orig<typeof import("@/lib/analytics/client")>();
  return { ...real, analyticsClient: { teams: vi.fn() } };
});
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const SRC = "0190e0c0-0000-7000-8000-00000000c5c5";
const none = { shown: null, all: null };

beforeEach(() => {
  vi.mocked(analyticsClient.teams).mockResolvedValue(
    ok({ teams: [{ id: "team-north", name: "North", memberIds: ["u-riya"] }] }),
  );
});

describe("Filters panel (8D-3 artboard)", () => {
  it("opens from its button, and each choice changes the view at once", async () => {
    const onChange = vi.fn();
    render(
      <FiltersButton
        filters={{}}
        catalog={testCatalog()}
        rangeDays={30}
        coverage={none}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const panel = await screen.findByRole("dialog", { name: "Filters" });
    await userEvent.click(within(panel).getByRole("button", { name: "leads-march.csv" }));
    expect(onChange).toHaveBeenLastCalledWith({ sources: [SRC] });
    await userEvent.click(within(panel).getByRole("checkbox", { name: /Riya Sharma/ }));
    expect(onChange).toHaveBeenLastCalledWith({ owners: ["u-riya"] });
    expect(within(panel).getByText("Every lead in the range")).toBeInTheDocument();
  });

  it("a team replaces people (one or the other), and a person shows their team", async () => {
    const onChange = vi.fn();
    render(
      <FiltersButton
        filters={{ owners: ["u-tas"] }}
        catalog={testCatalog()}
        rangeDays={30}
        coverage={none}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const panel = await screen.findByRole("dialog", { name: "Filters" });
    expect(await within(panel).findByText("North")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("radio", { name: "Teams" }));
    await userEvent.click(within(panel).getByRole("radio", { name: /North/ }));
    expect(onChange).toHaveBeenLastCalledWith({ team: "team-north" });
  });

  it("tags are counted live: past 92 days the panel says to pick a shorter range", async () => {
    render(
      <FiltersButton
        filters={{ tags: ["t-hot"] }}
        catalog={testCatalog()}
        rangeDays={365}
        coverage={{ shown: 12, all: 400 }}
        onChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const panel = await screen.findByRole("dialog", { name: "Filters" });
    expect(within(panel).getByText(/Pick a shorter range/)).toBeInTheDocument();
    expect(within(panel).getByText(/These numbers cover/)).toHaveTextContent(
      "These numbers cover 12 of 400 leads",
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("the Showing chips name each filter, and × takes one off", async () => {
    const onChange = vi.fn();
    render(
      <FilterChips
        filters={{ owners: ["u-riya", "u-tas"], tags: ["t-hot"] }}
        catalog={testCatalog()}
        teamName={null}
        onChange={onChange}
      />,
    );
    const bar = screen.getByRole("group", { name: "Filters on" });
    expect(bar).toHaveTextContent("People Riya and Leila");
    expect(bar).toHaveTextContent("Tags HotLive");
    await userEvent.click(within(bar).getByRole("button", { name: "Remove Tags" }));
    expect(onChange).toHaveBeenLastCalledWith({ owners: ["u-riya", "u-tas"] });
    await userEvent.click(within(bar).getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });
});
