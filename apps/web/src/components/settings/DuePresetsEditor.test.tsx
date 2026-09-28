import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DUE_PRESETS, type DuePresetDef } from "@lume/core/shared";
import { api } from "@/lib/api";
import { DuePresetsEditor } from "./DuePresetsEditor";

vi.mock("@/lib/api", () => ({ api: { put: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const lastPresets = () => (vi.mocked(api.put).mock.lastCall![1] as { duePresets: DuePresetDef[] }).duePresets;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.put).mockImplementation(async (_url, body) => ok(body as never));
});

describe("time choices (3C Task 6)", () => {
  it("each choice says when it lands, in words", () => {
    render(<DuePresetsEditor initial={DEFAULT_DUE_PRESETS} />);
    const list = screen.getByRole("list", { name: "Time choices" });
    expect(within(list).getByText("Tomorrow 10:00")).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "When for Tomorrow 10:00" })).toHaveTextContent(
      "tomorrow at 10:00",
    );
    expect(within(list).getByRole("button", { name: "When for Next Monday" })).toHaveTextContent(
      "next Monday at 10:00",
    );
  });

  it("adds one, sets when it lands, and saves each change as it's made", async () => {
    render(<DuePresetsEditor initial={DEFAULT_DUE_PRESETS} />);
    await userEvent.type(screen.getByRole("textbox", { name: "New time choice" }), "In 30 minutes{Enter}");
    expect(lastPresets().at(-1)).toMatchObject({
      label: "In 30 minutes",
      rule: { in: { n: 1, unit: "hour" } },
    });
    await userEvent.click(screen.getByRole("button", { name: "When for In 30 minutes" }));
    const n = screen.getByLabelText("How many");
    await userEvent.clear(n);
    await userEvent.type(n, "30");
    await userEvent.selectOptions(screen.getByLabelText("Minutes, hours or days"), "minute");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(lastPresets().at(-1)).toMatchObject({
      label: "In 30 minutes",
      rule: { in: { n: 30, unit: "minute" } },
    });
    expect(screen.getByRole("button", { name: "When for In 30 minutes" })).toHaveTextContent("in 30 minutes");
  });

  it("a day and a time, or a weekday", async () => {
    render(<DuePresetsEditor initial={[DEFAULT_DUE_PRESETS[0]!]} />);
    await userEvent.click(screen.getByRole("button", { name: "When for In 1 hour" }));
    await userEvent.selectOptions(screen.getByLabelText("Lands"), "weekday");
    await userEvent.selectOptions(screen.getByLabelText("Which day"), "5");
    await userEvent.clear(screen.getByLabelText("At"));
    await userEvent.type(screen.getByLabelText("At"), "09:30");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(lastPresets()[0]!.rule).toEqual({ weekday: { day: 5, time: "09:30" } });
  });

  it("the last one can't go", async () => {
    render(<DuePresetsEditor initial={[DEFAULT_DUE_PRESETS[0]!]} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove In 1 hour" }));
    await userEvent.click(screen.getByRole("button", { name: /^Remove$/ }));
    expect(api.put).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Keep at least one time choice");
  });

  it("a refusal puts it back and says why", async () => {
    vi.mocked(api.put).mockResolvedValue({
      ok: false,
      status: 400,
      code: "X",
      message: "Each time choice once",
    });
    render(<DuePresetsEditor initial={DEFAULT_DUE_PRESETS} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename In 1 hour" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Time choice name" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Time choice name" }), "Soon{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Each time choice once");
    expect(screen.getByText("In 1 hour")).toBeInTheDocument();
  });
});
