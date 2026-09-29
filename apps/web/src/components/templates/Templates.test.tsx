import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { templatesClient, type TemplateView } from "@/lib/templates/client";
import { TemplateEditor } from "./TemplateEditor";
import { TemplateLibrary } from "./TemplateLibrary";

vi.mock("@/lib/templates/client", () => ({
  templatesClient: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    reorder: vi.fn(),
    context: vi.fn(),
  },
}));
vi.mock("@/lib/leads/client", () => ({ leadsClient: { list: vi.fn() } }));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const t = (
  id: string,
  name: string,
  category: TemplateView["category"],
  body: string,
  o: Partial<TemplateView> = {},
): TemplateView => ({
  id,
  name,
  category,
  body,
  allowedRoleIds: [],
  versionId: `v-${id}`,
  version: 1,
  position: 0,
  updatedAt: "2026-09-29T10:00:00Z",
  usable: true,
  ...o,
});
const TEMPLATES = [
  t("t1", "First hello", "first_touch", "Hi {{lead.first_name}}, this is {{owner.first_name}}."),
  t("t2", "Gentle nudge", "follow_up", "Just checking in."),
  t("t3", "After the call", "follow_up", "Thanks for your time *today*."),
  t("t4", "Partners only", "custom", "Hello partner", { allowedRoleIds: ["r-partner"] }),
];
const ROLES = [
  { id: "r-partner", name: "Partners" },
  { id: "r-sales", name: "Sales" },
];
const FIELDS = [{ key: "package", label: "Package", type: "select" as const, options: [] }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(templatesClient.archive).mockResolvedValue(ok({ archived: true }) as never);
  vi.mocked(templatesClient.restore).mockImplementation(
    async (id) => ok(TEMPLATES.find((x) => x.id === id)!) as never,
  );
  vi.mocked(templatesClient.reorder).mockImplementation(
    async (ids) => ok({ templates: ids.map((id) => TEMPLATES.find((x) => x.id === id)!) }) as never,
  );
});

describe("the template library (4A Task 5)", () => {
  const library = (canManage = true) =>
    render(<TemplateLibrary initial={TEMPLATES} roles={ROLES} fields={FIELDS} canManage={canManage} />);

  it("grouped by category, each with its first line and who can use it", () => {
    library();
    const groups = screen.getAllByRole("list").map((l) => l.getAttribute("aria-label"));
    expect(groups).toEqual(["First touch", "Follow-up", "Custom"]);
    const followUps = screen.getByRole("list", { name: "Follow-up" });
    expect(within(followUps).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Hi {{lead.first_name}}, this is {{owner.first_name}}.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Custom" })).getByText("Partners")).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "First touch" })).getByText("Everyone"),
    ).toBeInTheDocument();
  });

  it("someone who only uses templates reads them: no New, no reorder, no archive, and no Save in the editor", async () => {
    library(false);
    expect(screen.queryByRole("button", { name: "New template" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^More for / })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^First hello/ }));
    const sheet = screen.getByRole("dialog", { name: "First hello" });
    expect(within(sheet).getByLabelText("Message")).toHaveAttribute("readonly");
    expect(within(sheet).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("archive takes it away, and Undo puts it back", async () => {
    library();
    await userEvent.click(screen.getByRole("button", { name: "More for Gentle nudge" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(templatesClient.archive).toHaveBeenCalledWith("t2");
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Gentle nudge/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Archived “Gentle nudge”");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(templatesClient.restore).toHaveBeenCalledWith("t2");
    expect(await screen.findByRole("button", { name: /^Gentle nudge/ })).toBeInTheDocument();
  });

  it("a save updates its card in place, and that card glows once so the eye finds it", async () => {
    vi.mocked(templatesClient.update).mockImplementation(
      async (id, b) => ok({ ...TEMPLATES[1]!, ...b, version: 2 }) as never,
    );
    library();
    await userEvent.click(screen.getByRole("button", { name: /^Gentle nudge/ }));
    const sheet = screen.getByRole("dialog", { name: "Gentle nudge" });
    await userEvent.clear(within(sheet).getByLabelText("Message"));
    await userEvent.type(within(sheet).getByLabelText("Message"), "Still keen?");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    const card = (await screen.findByText("Still keen?", { selector: "span" })).closest("li")!;
    expect(card).toHaveAttribute("data-fresh");
    expect(screen.getByRole("button", { name: /^First hello/ }).closest("li")).not.toHaveAttribute(
      "data-fresh",
    );
  });

  it("reorder within a group by keyboard: Alt+↓ on the handle", async () => {
    library();
    screen.getByRole("button", { name: "Move Gentle nudge" }).focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(templatesClient.reorder).toHaveBeenCalledWith(["t1", "t3", "t2", "t4"]);
  });
});

describe("the template editor (4A Task 5)", () => {
  const editor = (o: { template?: TemplateView; readOnly?: boolean } = {}) => {
    const onSaved = vi.fn();
    render(
      <TemplateEditor
        {...(o.template ? { template: o.template } : {})}
        roles={ROLES}
        fields={FIELDS}
        readOnly={o.readOnly ?? false}
        onSaved={onSaved}
        onClose={vi.fn()}
      />,
    );
    return onSaved;
  };
  const body = () => screen.getByLabelText("Message") as HTMLTextAreaElement;

  it("a new template: name, category, a variable at the caret, previewed as WhatsApp will show it, saved as version 1", async () => {
    vi.mocked(templatesClient.create).mockImplementation(
      async (b) => ok(t("t9", b.name, b.category, b.body)) as never,
    );
    const onSaved = editor();
    await userEvent.type(screen.getByLabelText("Name"), "Welcome");
    await userEvent.click(screen.getByRole("radio", { name: "Follow-up" }));
    await userEvent.type(body(), "Hi , welcome to *our studio*");
    body().setSelectionRange(3, 3);
    await userEvent.click(screen.getByRole("button", { name: "Insert First name" }));
    expect(body().value).toBe("Hi {{lead.first_name}}, welcome to *our studio*");
    const bubble = screen.getByRole("figure", { name: "Preview" });
    expect(within(bubble).getByText("our studio").tagName).toBe("STRONG");
    expect(bubble).toHaveTextContent(/^Hi Alex, welcome to our studio/); // the sample lead, until one is picked
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(templatesClient.create).toHaveBeenCalledWith({
      name: "Welcome",
      category: "follow_up",
      body: "Hi {{lead.first_name}}, welcome to *our studio*",
      allowedRoleIds: [],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved as version 1");
    expect(onSaved).toHaveBeenCalled();
  });

  it("typing {{ offers the variables; Enter puts one in", async () => {
    editor();
    await userEvent.type(body(), "Hi {{{{lead.f"); // user-event reads {{ as a literal {
    const list = screen.getByRole("listbox", { name: "Variables" });
    expect(within(list).getByRole("option", { name: "First name" })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(body().value).toBe("Hi {{lead.first_name}}");
    expect(screen.queryByRole("listbox", { name: "Variables" })).not.toBeInTheDocument();
  });

  it("meeting details say they need Calendar; a missing value shows in amber", async () => {
    editor();
    expect(screen.getByRole("button", { name: "Insert Meeting date" })).toBeDisabled();
    await userEvent.type(body(), "Package: {{{{lead.custom.package}}");
    const bubble = screen.getByRole("figure", { name: "Preview" });
    expect(within(bubble).getByText("{{lead.custom.package}}")).toHaveAttribute("data-missing");
  });

  it("the count, and past 1,000 a gentle warning", async () => {
    editor();
    await userEvent.click(body());
    await userEvent.paste("x".repeat(1001));
    const count = screen.getByText(/^1,001/);
    expect(count.closest("[data-long]")).not.toBeNull();
  });

  it("an edit to the words is saved as the next version; only chosen roles can use it", async () => {
    vi.mocked(templatesClient.update).mockImplementation(
      async (id, b) => ok({ ...TEMPLATES[1]!, ...b, version: 2 }) as never,
    );
    editor({ template: TEMPLATES[1]! });
    await userEvent.clear(body());
    await userEvent.type(body(), "Still keen?");
    await userEvent.click(screen.getByRole("radio", { name: "Only these roles" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Sales" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(templatesClient.update).toHaveBeenCalledWith("t2", {
      name: "Gentle nudge",
      category: "follow_up",
      body: "Still keen?",
      allowedRoleIds: ["r-sales"],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved as version 2");
  });

  it("preview as a real lead: their words, fetched once, then every keystroke is local", async () => {
    vi.mocked(leadsClient.list).mockResolvedValue(
      ok({ items: [{ id: "l1", name: "Aisha Khan" }], nextCursor: null, total: 1 }) as never,
    );
    vi.mocked(templatesClient.context).mockResolvedValue(
      ok({
        lead: { name: "Aisha Khan", custom: {} },
        owner: { name: "Riya Sharma" },
        business: { name: "Brightpath Studio", currency: "AED", timezone: "Asia/Dubai" },
        fields: [],
        people: [],
      }) as never,
    );
    editor({ template: TEMPLATES[0]! });
    await userEvent.type(screen.getByRole("combobox", { name: "Preview as" }), "Ais");
    await userEvent.click(await screen.findByRole("option", { name: "Aisha Khan" }));
    const bubble = screen.getByRole("figure", { name: "Preview" });
    await vi.waitFor(() => expect(bubble).toHaveTextContent("Hi Aisha, this is Riya."));
    await userEvent.type(body(), "!");
    expect(bubble).toHaveTextContent("Hi Aisha, this is Riya.!");
    expect(templatesClient.context).toHaveBeenCalledTimes(1);
  });

  it("read-only: nothing to change, nothing to save, the preview still works", () => {
    editor({ template: TEMPLATES[0]!, readOnly: true });
    expect(body()).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Name")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "Preview" })).toHaveTextContent("Hi Alex");
  });
});

void act;
