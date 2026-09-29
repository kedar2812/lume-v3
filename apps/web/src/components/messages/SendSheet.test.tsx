import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderContext } from "@lume/core/shared";
import { leadsClient } from "@/lib/leads/client";
import { templatesClient, type TemplateView } from "@/lib/templates/client";
import { SendSheet } from "./SendSheet";

vi.mock("@/lib/templates/client", () => ({ templatesClient: { list: vi.fn(), context: vi.fn() } }));
vi.mock("@/lib/leads/client", () => ({
  leadsClient: { prepareMessage: vi.fn(), confirmMessage: vi.fn(), move: vi.fn() },
}));
const play = vi.fn();
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play }) }));
let reduce = false;
vi.mock("motion/react", async (orig) => ({
  ...(await orig<typeof import("motion/react")>()),
  useReducedMotion: () => reduce,
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const t = (id: string, name: string, category: TemplateView["category"], body: string, usable = true) =>
  ({
    id,
    name,
    category,
    body,
    allowedRoleIds: [],
    versionId: `v-${id}`,
    version: 1,
    position: 0,
    updatedAt: "2026-09-29T10:00:00Z",
    usable,
  }) satisfies TemplateView;
const TEMPLATES = [
  t("t1", "First hello", "first_touch", "Hi {{lead.first_name}}, this is {{owner.first_name}}."),
  t("t2", "Gentle nudge", "follow_up", "Just checking in, {{lead.first_name}}."),
  t("t3", "Package check", "follow_up", "Still keen on {{lead.custom.package}}?"),
  t("t4", "Come back", "re_engagement", "We miss you, {{lead.first_name}}."),
  t("t5", "Partners only", "custom", "Hello partner", false),
];
const CTX: RenderContext = {
  lead: { name: "Aisha Khan", custom: {} },
  owner: { name: "Riya Sharma" },
  business: { name: "Acme Studio", currency: "AED", timezone: "Asia/Dubai" },
  fields: [{ key: "package", type: "text" }],
  people: [],
};
const LEAD = { id: "l1", name: "Aisha Khan" };

const tab = () => {
  const w = { location: { href: "" }, close: vi.fn(), opener: {} as unknown };
  vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);
  return w;
};
const sheet = async (props: Partial<Parameters<typeof SendSheet>[0]> = {}) => {
  const onChange = vi.fn();
  const onSettled = vi.fn();
  render(<SendSheet lead={LEAD} onChange={onChange} onSettled={onSettled} {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
  const dialog = screen.getByRole("dialog", { name: "WhatsApp Aisha Khan" });
  await within(dialog).findByRole("option", { name: /First hello/ });
  return { dialog, onChange, onSettled };
};
const names = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole("option")
    .map((o) => o.getAttribute("data-name"));
const message = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

beforeEach(() => {
  vi.clearAllMocks();
  reduce = false;
  vi.mocked(templatesClient.list).mockResolvedValue(ok({ templates: TEMPLATES }) as never);
  vi.mocked(templatesClient.context).mockResolvedValue(ok(CTX) as never);
  vi.mocked(leadsClient.prepareMessage).mockResolvedValue(ok({ url: "https://wa.me/971501234567" }) as never);
});

describe("the send sheet (4A Task 6)", () => {
  it("lists the templates your role can use, the context's kind first, then yours to write", async () => {
    const { dialog } = await sheet({ suggest: "follow_up" });
    expect(names(dialog)).toEqual([
      "Gentle nudge",
      "Package check",
      "First hello",
      "Come back",
      "Write your own",
    ]);
  });

  it("each template's first line names its variables as chips, never {{code}}", async () => {
    const { dialog } = await sheet();
    const hello = within(dialog).getByRole("option", { name: /First hello/ });
    expect(within(hello).getByText("First name", { selector: "[data-token]" })).toBeInTheDocument();
    expect(hello).not.toHaveTextContent("{{");
  });

  it("a lost lead's sheet starts with Re-engagement", async () => {
    const { dialog } = await sheet({ suggest: "re_engagement" });
    expect(names(dialog)[0]).toBe("Come back");
  });

  it("a template renders in the lead's own words, and the words stay yours to edit", async () => {
    const { dialog } = await sheet();
    await userEvent.click(within(dialog).getByRole("option", { name: /First hello/ }));
    expect(message().value).toBe("Hi Aisha, this is Riya.");
    await userEvent.type(message(), " See you soon!");
    expect(message().value).toBe("Hi Aisha, this is Riya. See you soon!");
  });

  it("says what's missing, and the line goes once it's filled in", async () => {
    const { dialog } = await sheet();
    await userEvent.click(within(dialog).getByRole("option", { name: /Package check/ }));
    expect(message().value).toBe("Still keen on {{lead.custom.package}}?");
    expect(
      within(dialog).getByText("Missing: lead.custom.package. Fill it in, or LUME sends it as is."),
    ).toBeVisible();
    expect(dialog.querySelector("mark[data-missing]")).toHaveTextContent("{{lead.custom.package}}");
    await userEvent.clear(message());
    await userEvent.type(message(), "Still keen on the retreat?");
    expect(within(dialog).queryByText(/^Missing:/)).not.toBeInTheDocument();
  });

  it("the keyboard: ↓ picks, Enter renders, Ctrl+Enter opens WhatsApp", async () => {
    const w = tab();
    const { dialog } = await sheet({ suggest: "follow_up" });
    const list = within(dialog).getByRole("listbox", { name: "Templates" });
    list.focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(message().value).toBe("Still keen on {{lead.custom.package}}?");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await vi.waitFor(() => expect(w.location.href).toBe("https://wa.me/971501234567"));
  });

  it("sends the version you saw, and the follow-up it came from", async () => {
    const w = tab();
    const { dialog } = await sheet({ taskId: "task-1", suggest: "follow_up" });
    await userEvent.click(within(dialog).getByRole("option", { name: /Gentle nudge/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Open WhatsApp" }));
    expect(leadsClient.prepareMessage).toHaveBeenCalledWith("l1", "Just checking in, Aisha.", {
      templateVersionId: "v-t2",
      taskId: "task-1",
    });
    await vi.waitFor(() => expect(w.location.href).toBe("https://wa.me/971501234567"));
    expect(w.opener).toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("your own words carry no template", async () => {
    tab();
    const { dialog } = await sheet();
    await userEvent.click(within(dialog).getByRole("option", { name: "Write your own" }));
    await userEvent.type(message(), "Hello there");
    await userEvent.click(within(dialog).getByRole("button", { name: "Open WhatsApp" }));
    expect(leadsClient.prepareMessage).toHaveBeenCalledWith("l1", "Hello there", {});
  });

  it("can't prepare: the blank tab closes and LUME says why", async () => {
    const w = tab();
    vi.mocked(leadsClient.prepareMessage).mockResolvedValue({
      ok: false,
      status: 422,
      code: "NO_WHATSAPP_NUMBER",
      message: "This lead has no WhatsApp number",
    } as never);
    const { dialog } = await sheet();
    await userEvent.click(within(dialog).getByRole("button", { name: "Open WhatsApp" }));
    await vi.waitFor(() => expect(w.close).toHaveBeenCalled());
    expect(within(dialog).getByRole("alert")).toHaveTextContent("This lead has no WhatsApp number");
  });
});

describe("the Sent prompt (4A Task 6)", () => {
  const sendAndReturn = async (props: Partial<Parameters<typeof SendSheet>[0]> = {}) => {
    tab();
    const s = await sheet(props);
    await userEvent.click(within(s.dialog).getByRole("option", { name: /Gentle nudge/ }));
    await userEvent.click(within(s.dialog).getByRole("button", { name: "Open WhatsApp" }));
    await vi.waitFor(() => expect(leadsClient.prepareMessage).toHaveBeenCalled());
    window.dispatchEvent(new Event("focus"));
    return { ...s, prompt: await screen.findByRole("group", { name: "Was the WhatsApp message sent?" }) };
  };

  it("Yes, sent: the sound, the move it made, and Undo moves it back", async () => {
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue(
      ok({ moved: { stageId: "s2", stageName: "Message sent", fromStageId: "s1" } }) as never,
    );
    vi.mocked(leadsClient.move).mockResolvedValue(ok({ lead: {} }) as never);
    const { prompt, onChange } = await sendAndReturn({ taskId: "task-1" });
    await userEvent.click(within(prompt).getByRole("button", { name: "Yes, sent" }));
    expect(leadsClient.confirmMessage).toHaveBeenCalledWith("l1", true, "task-1");
    expect(play).toHaveBeenCalledWith("sent");
    const status = await screen.findByRole("status");
    await vi.waitFor(() => expect(status).toHaveTextContent("Moved to Message sent"));
    expect(onChange).toHaveBeenCalled();
    await userEvent.click(within(status).getByRole("button", { name: "Undo" }));
    expect(leadsClient.move).toHaveBeenCalledWith("l1", "s1");
  });

  it("once the lead moves on again (a reply, a drag), the send's Undo goes: it would undo the wrong move", async () => {
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue(
      ok({ moved: { stageId: "s2", stageName: "Message sent", fromStageId: "s1" } }) as never,
    );
    tab();
    const onChange = vi.fn();
    const { rerender } = render(<SendSheet lead={LEAD} stageId="s1" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
    const dialog = screen.getByRole("dialog", { name: "WhatsApp Aisha Khan" });
    await userEvent.click(await within(dialog).findByRole("button", { name: "Open WhatsApp" }));
    await vi.waitFor(() => expect(leadsClient.prepareMessage).toHaveBeenCalled());
    window.dispatchEvent(new Event("focus"));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, sent" }));
    const status = await screen.findByRole("status");
    await vi.waitFor(() => expect(within(status).getByRole("button", { name: "Undo" })).toBeInTheDocument());
    rerender(<SendSheet lead={LEAD} stageId="s2" onChange={onChange} />); // where the send put it: Undo stays
    expect(within(status).getByRole("button", { name: "Undo" })).toBeInTheDocument();
    rerender(<SendSheet lead={LEAD} stageId="s3" onChange={onChange} />); // moved on since
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument());
  });

  it("a move the stage refused says why, in LUME's words, and the send still counts", async () => {
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue(
      ok({
        moved: null,
        notMoved: { code: "REQUIRED_FIELDS", message: "Fill in Package before moving to Message sent" },
      }) as never,
    );
    const { prompt } = await sendAndReturn();
    await userEvent.click(within(prompt).getByRole("button", { name: "Yes, sent" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Sent");
    await vi.waitFor(() => expect(status).toHaveTextContent("Fill in Package before moving to Message sent"));
    expect(within(status).queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("while it asks or answers, the sheet says it's live, so a row that hides its actions keeps them shown", async () => {
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue(ok({ moved: null }) as never);
    const { prompt, onSettled } = await sendAndReturn();
    expect(prompt.closest("[data-whatsapp]")).toHaveAttribute("data-live");
    await userEvent.click(within(prompt).getByRole("button", { name: "Not sent" }));
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(document.querySelector("[data-whatsapp]")).not.toHaveAttribute("data-live");
  });

  it("Not sent: logged quietly, no sound, and the prompt goes", async () => {
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue(ok({ moved: null }) as never);
    const { prompt, onSettled } = await sendAndReturn();
    await userEvent.click(within(prompt).getByRole("button", { name: "Not sent" }));
    expect(leadsClient.confirmMessage).toHaveBeenCalledWith("l1", false, undefined);
    expect(play).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(false));
  });

  it("with Reduce Motion the prompt still asks, and answers the same", async () => {
    reduce = true;
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue(ok({ moved: null }) as never);
    const { prompt } = await sendAndReturn();
    await userEvent.click(within(prompt).getByRole("button", { name: "Yes, sent" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sent");
  });
});
