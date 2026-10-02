import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OnEnter, StageRule } from "@lume/core/shared";
import { StageAutomations } from "./StageAutomations";

const people = [
  { id: "0192f0a0-0000-7000-8000-0000000000aa", name: "Riya Shah", active: true },
  { id: "0192f0a0-0000-7000-8000-0000000000bb", name: "Omar Ali", active: true },
];
const stage = { id: "s1", name: "Contacted" };
const task: StageRule = {
  id: "0192f0a0-0000-7000-8000-000000000001",
  type: "create_task",
  title: "Send the plan",
  dueIn: { n: 2, unit: "day" },
  assignee: "lead_owner",
};
const open = (
  rules: StageRule[] = [],
  onSave = vi.fn<(o: OnEnter) => Promise<string | null>>(async () => null),
) => {
  render(<StageAutomations stage={stage} rules={rules} people={people} onSave={onSave} onClose={vi.fn()} />);
  return { onSave, sheet: screen.getByRole("dialog", { name: "What Contacted does" }) };
};

describe("a stage's automations (3C Task 6)", () => {
  it("each automation reads as a sentence", () => {
    const { sheet } = open([task, { id: "0192f0a0-0000-7000-8000-000000000002", type: "cancel_open_tasks" }]);
    expect(
      within(sheet).getByText("Sets a follow-up for the lead's owner in 2 days: Send the plan"),
    ).toBeInTheDocument();
    expect(within(sheet).getByText("Clears the lead's open follow-ups")).toBeInTheDocument();
    expect(within(sheet).getByText(/Imports don't run it/)).toBeInTheDocument();
  });

  it("adds a follow-up for someone, in hours, and saves the lot once", async () => {
    const { onSave, sheet } = open();
    await userEvent.click(within(sheet).getByRole("button", { name: "Set a follow-up" }));
    await userEvent.type(within(sheet).getByLabelText("Follow-up title"), "Call within the hour");
    const n = within(sheet).getByLabelText("How long after");
    await userEvent.clear(n);
    await userEvent.type(n, "1");
    await userEvent.selectOptions(within(sheet).getByLabelText("Hours or days"), "hour");
    await userEvent.selectOptions(within(sheet).getByLabelText("For"), "Riya Shah");
    expect(
      within(sheet).getByText("Sets a follow-up for Riya Shah in 1 hour: Call within the hour"),
    ).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      {
        rules: [
          {
            id: expect.any(String),
            type: "create_task",
            title: "Call within the hour",
            dueIn: { n: 1, unit: "hour" },
            assignee: { userId: people[0]!.id },
          },
        ],
      },
      {}, // no moves changed
    );
  });

  it("tells chosen people; removing one leaves the rest", async () => {
    const { onSave, sheet } = open([task]);
    await userEvent.click(within(sheet).getByRole("button", { name: "Tell someone" }));
    await userEvent.click(within(sheet).getByRole("checkbox", { name: "Omar Ali" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Remove automation 1" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      { rules: [{ id: expect.any(String), type: "notify", to: [{ userId: people[1]!.id }] }] },
      {},
    );
  });

  it("says what's wrong in LUME's words before asking the server", async () => {
    const { onSave, sheet } = open();
    await userEvent.click(within(sheet).getByRole("button", { name: "Set a follow-up" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Give the follow-up a title");
    await userEvent.click(within(sheet).getByRole("button", { name: "Remove automation 1" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Tell someone" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Pick who to tell");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("five at most; and the server's refusal is shown as it is", async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      ...task,
      id: `0192f0a0-0000-7000-8000-00000000001${i}`,
    }));
    const refuse = vi.fn<(o: OnEnter) => Promise<string | null>>(
      async () => "One of the people in these automations doesn't exist or is disabled",
    );
    const { sheet } = open(five, refuse);
    for (const name of ["Set a follow-up", "Clear open follow-ups", "Tell someone"])
      expect(within(sheet).getByRole("button", { name })).toBeDisabled();
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("doesn't exist or is disabled");
  });
});

describe("a stage's automations: 3C final review", () => {
  it("Important 6: someone no longer active is shown as such, and can be taken out", async () => {
    const gone = { id: "0192f0a0-0000-7000-8000-0000000000cc", name: "Zara Malik", active: false };
    const onSave = vi.fn<(o: OnEnter) => Promise<string | null>>(async () => null);
    render(
      <StageAutomations
        stage={stage}
        rules={[
          { ...task, assignee: { userId: gone.id } },
          { id: "0192f0a0-0000-7000-8000-000000000009", type: "notify", to: [{ userId: gone.id }] },
        ]}
        people={[...people, gone]}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const sheet = screen.getByRole("dialog", { name: "What Contacted does" });
    expect(within(sheet).getByLabelText("For")).toHaveDisplayValue("Zara Malik (no longer active)");
    expect(
      within(sheet).getByText(/Sets a follow-up for Zara Malik \(no longer active\)/),
    ).toBeInTheDocument();
    await userEvent.selectOptions(within(sheet).getByLabelText("For"), "the lead's owner");
    await userEvent.click(within(sheet).getByRole("checkbox", { name: "Zara Malik (no longer active)" }));
    await userEvent.click(within(sheet).getByRole("checkbox", { name: "The lead's owner" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      {
        rules: [
          expect.objectContaining({ assignee: "lead_owner" }),
          expect.objectContaining({ to: ["lead_owner"] }),
        ],
      },
      {},
    );
  });
});

describe("the meeting reminder (5D Task 9)", () => {
  const TEMPLATES = [
    {
      id: "0192f0a0-0000-7000-8000-0000000000a1",
      name: "See you soon",
      body: "Hi {{lead.first_name}}, see you soon!",
    },
    {
      id: "0192f0a0-0000-7000-8000-0000000000a2",
      name: "Call reminder",
      body: "Our call is at {{meeting.time}}.",
    },
  ];
  const remind: StageRule = {
    id: "0192f0a0-0000-7000-8000-000000000009",
    type: "remind_before_meeting",
    hoursBefore: 2,
    templateId: TEMPLATES[0]!.id,
  };
  const openWith = (
    rules: StageRule[],
    onSave = vi.fn<(o: OnEnter) => Promise<string | null>>(async () => null),
  ) => {
    render(
      <StageAutomations
        stage={stage}
        rules={rules}
        people={people}
        templates={TEMPLATES}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    return { onSave, sheet: screen.getByRole("dialog", { name: "What Contacted does" }) };
  };

  it("says honestly who sends it, steps the hours, picks the message, and previews it", async () => {
    const { onSave, sheet } = openWith([remind]);
    expect(
      within(sheet).getByText(/owner a WhatsApp reminder for the lead, 2 hours before their meeting/),
    ).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "One hour more" }));
    expect(within(sheet).getByRole("spinbutton", { name: "Hours before the meeting" })).toHaveValue(3);
    await userEvent.selectOptions(within(sheet).getByRole("combobox", { name: "Message" }), "Call reminder");
    expect(within(sheet).getByTestId("reminder-preview")).toHaveTextContent("Our call is at");
    expect(
      within(sheet).getByText("If a call is booked sooner than this, LUME skips the reminder."),
    ).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      { rules: [{ ...remind, hoursBefore: 3, templateId: TEMPLATES[1]!.id }] },
      {},
    );
  });

  it("is offered once: with one there, Add can't add another", () => {
    const { sheet } = openWith([remind]);
    expect(within(sheet).getByRole("button", { name: /Remind the lead before their call/ })).toBeDisabled();
  });

  it("removing one has Undo", async () => {
    const { sheet } = openWith([remind]);
    await userEvent.click(within(sheet).getByRole("button", { name: "Remove automation 1" }));
    // It leaves with its exit animation, then Undo brings it back as it was.
    await vi.waitFor(() =>
      expect(
        within(sheet).queryByRole("spinbutton", { name: "Hours before the meeting" }),
      ).not.toBeInTheDocument(),
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Undo" }));
    expect(within(sheet).getByRole("spinbutton", { name: "Hours before the meeting" })).toHaveValue(2);
  });

  it("with no reminder message yet, says to write one first, and adds none", () => {
    render(
      <StageAutomations
        stage={stage}
        rules={[]}
        people={people}
        templates={[]}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const sheet = screen.getByRole("dialog", { name: "What Contacted does" });
    expect(within(sheet).getByRole("button", { name: /Remind the lead before their call/ })).toBeDisabled();
    expect(within(sheet).getByText(/Write a reminder message in Templates first/)).toBeInTheDocument();
  });
});
