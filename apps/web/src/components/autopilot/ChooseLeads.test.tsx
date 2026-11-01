import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { ChooseLeads } from "./ChooseLeads";

vi.mock("@/lib/leads/client", () => ({ leadsClient: { list: vi.fn() } }));
const list = vi.mocked(leadsClient.list);
const page = (names: string[], more = false) => ({
  ok: true as const,
  status: 200,
  data: {
    items: names.map((name) => ({ id: name.toLowerCase().replace(/\W/g, "-"), name })),
    nextCursor: more ? "c" : null,
  },
});

describe("New run's first step: choose the leads in LUME AI (2026-11-01)", () => {
  beforeEach(() => {
    list.mockReset();
    list.mockImplementation(
      async (f) =>
        page(
          f.q
            ? ["Sneha Reddy"].filter((n) => n.toLowerCase().includes(f.q!.toLowerCase()))
            : ["Meera Iyer", "Rohan Gupta"],
        ) as never,
    );
  });

  it("those waiting on a reply first; ticked ones go on to the start sheet", async () => {
    const onContinue = vi.fn();
    render(<ChooseLeads onClose={vi.fn()} onContinue={onContinue} />);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ noReplyDays: 3 }), undefined, 100);
    const go = screen.getByRole("button", { name: "Continue" });
    expect(go).toBeDisabled();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Rohan Gupta" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue with 1" }));
    expect(onContinue).toHaveBeenCalledWith(["rohan-gupta"]);
  });

  it("search finds anyone by name or number, and what's ticked stays ticked across searches", async () => {
    const onContinue = vi.fn();
    render(<ChooseLeads onClose={vi.fn()} onContinue={onContinue} />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Meera Iyer" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search leads" }), "sneha");
    await userEvent.click(await screen.findByRole("checkbox", { name: "Sneha Reddy" }));
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "sneha" }), undefined, 100);
    expect(screen.getByText("2 chosen")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue with 2" }));
    expect(onContinue).toHaveBeenCalledWith(["meera-iyer", "sneha-reddy"]);
  });

  it("tick all shown, or untick them; a search that finds nobody says so; another filter asks again", async () => {
    render(<ChooseLeads onClose={vi.fn()} onContinue={vi.fn()} />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Tick all 2" }));
    expect(screen.getByText("2 chosen")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Untick all 2" }));
    expect(screen.getByText("Tick the leads LUME AI should follow up")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "All leads" }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(expect.not.objectContaining({ noReplyDays: 3 }), undefined, 100),
    );
    await userEvent.type(screen.getByRole("searchbox", { name: "Search leads" }), "zzz");
    expect(await screen.findByText("No lead matches “zzz” here.")).toBeInTheDocument();
  });

  it("more than a page: says how to find the rest", async () => {
    list.mockResolvedValue(page(["Meera Iyer"], true) as never);
    render(<ChooseLeads onClose={vi.fn()} onContinue={vi.fn()} />);
    expect(await screen.findByText("Showing the first 100. Search to find anyone else.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Tick all 1 shown" })).toBeInTheDocument();
  });
});
