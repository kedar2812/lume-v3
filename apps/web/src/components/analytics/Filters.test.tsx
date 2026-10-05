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

  it("with two pipelines: All pipelines until one is picked, and the default one can be picked", async () => {
    const onChange = vi.fn();
    const cat = testCatalog({
      pipelines: [
        { ...testCatalog().pipelines[0]!, id: "p1", name: "Coaching sales", isDefault: true },
        { ...testCatalog().pipelines[0]!, id: "p2", name: "Corporate", isDefault: false },
      ],
    });
    render(<FiltersButton filters={{}} catalog={cat} rangeDays={30} coverage={none} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const panel = await screen.findByRole("dialog", { name: "Filters" });
    expect(within(panel).getByRole("radio", { name: "All pipelines" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(within(panel).getByRole("radio", { name: "Coaching sales" }));
    expect(onChange).toHaveBeenLastCalledWith({ pipeline: "p1" });
  });

  it("people are only those the viewer can see: a team's members and themselves; none for someone who sees their own", async () => {
    const cat = testCatalog({
      people: [
        { id: "u-riya", name: "Riya Sharma", active: true },
        { id: "u-tas", name: "Leila Haddad", active: true },
        { id: "u-me", name: "Maya Kapoor", active: true },
      ],
    });
    const { unmount } = render(
      <FiltersButton
        filters={{}}
        catalog={cat}
        rangeDays={30}
        coverage={none}
        onChange={vi.fn()}
        reach="team"
        meId="u-me"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const panel = await screen.findByRole("dialog", { name: "Filters" });
    expect(await within(panel).findByRole("checkbox", { name: /Riya Sharma/ })).toBeInTheDocument();
    expect(within(panel).getByRole("checkbox", { name: /Maya Kapoor/ })).toBeInTheDocument();
    expect(within(panel).queryByRole("checkbox", { name: /Leila Haddad/ })).not.toBeInTheDocument();
    unmount();
    render(
      <FiltersButton
        filters={{}}
        catalog={cat}
        rangeDays={30}
        coverage={none}
        onChange={vi.fn()}
        reach="own"
        meId="u-me"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const own = await screen.findByRole("dialog", { name: "Filters" });
    expect(within(own).queryByText("People")).not.toBeInTheDocument();
  });

  it("fields stop at what LUME can count at once: three fields, ten answers each", async () => {
    const field = (n: number) => ({
      id: `f${n}`,
      key: `q${n}`,
      label: `Question ${n}`,
      type: "select" as const,
      options: Array.from({ length: 12 }, (_, i) => ({ id: `o${n}-${i}`, label: `A${n}-${i}` })),
      isCore: false,
      isRequired: false,
      archived: false,
      access: "edit" as const,
    });
    const cat = testCatalog({ fields: [field(1), field(2), field(3), field(4)] });
    const fields = { q1: ["o1-0"], q2: ["o2-0"], q3: Array.from({ length: 10 }, (_, i) => `o3-${i}`) };
    render(
      <FiltersButton filters={{ fields }} catalog={cat} rangeDays={30} coverage={none} onChange={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const panel = await screen.findByRole("dialog", { name: "Filters" });
    expect(within(panel).getByRole("button", { name: "A4-0" })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: "A3-10" })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: "A1-1" })).toBeEnabled();
    expect(within(panel).getByText(/up to 3 fields/)).toBeInTheDocument();
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
