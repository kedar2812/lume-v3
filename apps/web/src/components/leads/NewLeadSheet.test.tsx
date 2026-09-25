import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { testCatalog, testLead } from "@/lib/leads/test-catalog";
import { fakeSession } from "@/server/session";
import { CatalogProvider } from "./CatalogProvider";
import { NewLeadSheet } from "./NewLeadSheet";

vi.mock("@/lib/leads/client", () => ({ leadsClient: { create: vi.fn(), duplicates: vi.fn() } }));
// jsdom runs no animations; a plain element per tag keeps inputs mounted between renders.
vi.mock("motion/react", async () => {
  const { createElement, forwardRef } = await import("react");
  const strip = ({ initial, animate, exit, transition, ...rest }: Record<string, unknown>) => (
    void initial,
    void animate,
    void exit,
    void transition,
    rest
  );
  const made = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) => {
        if (!made.has(tag))
          made.set(
            tag,
            forwardRef((p: Record<string, unknown>, ref) => createElement(tag, { ...strip(p), ref })),
          );
        return made.get(tag);
      },
    },
  );
  return { motion, useReducedMotion: () => true };
});

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const creator = (extra: { key: "leads.assign"; scope: "own" | "team" | "all" }[] = []) =>
  fakeSession({
    permissions: [{ key: "leads.view", scope: "all" }, { key: "leads.create", scope: null }, ...extra],
  });
const open = (session = creator()) => {
  const onCreated = vi.fn();
  render(
    <CatalogProvider catalog={testCatalog()}>
      <NewLeadSheet session={session} onCreated={onCreated} onClose={vi.fn()} />
    </CatalogProvider>,
  );
  return onCreated;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(leadsClient.duplicates).mockResolvedValue(ok({ duplicates: [] }));
});

describe("NewLeadSheet", () => {
  it("creates a lead with the essentials and hands it back", async () => {
    vi.mocked(leadsClient.create).mockResolvedValue({
      ok: true,
      status: 201,
      data: { lead: testLead({ id: "new" }), duplicates: [] },
    });
    const onCreated = open();
    await userEvent.type(screen.getByLabelText("Name"), "Aisha Khan");
    await userEvent.type(screen.getByLabelText("Phone"), "+971501234567");
    await userEvent.click(screen.getByRole("button", { name: "Create lead" }));
    expect(leadsClient.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Aisha Khan", phone: "+971501234567", stageId: "s-new" }),
    );
    expect(Object.keys(vi.mocked(leadsClient.create).mock.calls[0]![0])).not.toContain("email"); // empty stays out
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }));
  });

  it("adds the business country's code to a number typed without one, and another country's when picked", async () => {
    vi.mocked(leadsClient.create).mockResolvedValue({
      ok: true,
      status: 201,
      data: { lead: testLead({ id: "new" }), duplicates: [] },
    });
    open();
    await userEvent.type(screen.getByLabelText("Name"), "Aisha Khan");
    expect(screen.getByRole("button", { name: /^Country code/ })).toHaveAccessibleName(
      "Country code: United Arab Emirates +971",
    );
    await userEvent.type(screen.getByLabelText("Phone"), "050 123 4567");
    await userEvent.click(screen.getByRole("button", { name: "Create lead" }));
    expect(leadsClient.create).toHaveBeenLastCalledWith(expect.objectContaining({ phone: "+971501234567" }));

    await userEvent.click(screen.getByRole("button", { name: /^Country code/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Search countries" }), "india{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Create lead" }));
    expect(leadsClient.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ phone: "+91 050 123 4567" }),
    );
  });

  it("warns about a duplicate as the phone is typed, naming the owner only when allowed", async () => {
    vi.mocked(leadsClient.duplicates).mockResolvedValue(
      ok({
        duplicates: [
          { visible: true, leadId: "l9", name: "Aisha K", ownerName: "Riya Sharma", matchedOn: ["phone"] },
        ],
      }),
    );
    open();
    await userEvent.type(screen.getByLabelText("Phone"), "+971501234567");
    // The status line is always there (so screen readers hear it change); wait for what it says.
    await vi.waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Aisha K already has this phone · handled by Riya Sharma",
      ),
    );
    expect(screen.getByRole("link", { name: "Open Aisha K" })).toHaveAttribute("href", "/leads?lead=l9");
  });

  it("says only that a lead exists when the caller may not see it", async () => {
    vi.mocked(leadsClient.duplicates).mockResolvedValue(
      ok({ duplicates: [{ visible: false, matchedOn: ["email"] }] }),
    );
    open();
    await userEvent.type(screen.getByLabelText("Email"), "aisha@example.com");
    await vi.waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("A lead with this email already exists"),
    );
    expect(screen.queryByRole("link", { name: /open/i })).not.toBeInTheDocument();
  });

  it("needs a name, and shows the API's reason for a bad field next to it", async () => {
    vi.mocked(leadsClient.create).mockResolvedValue({
      ok: false,
      status: 400,
      code: "VALIDATION_FAILED",
      message: "Check the highlighted fields",
      details: [{ instancePath: "/email", message: "Invalid email address" }],
    });
    open();
    await userEvent.click(screen.getByRole("button", { name: "Create lead" }));
    expect(screen.getByText("Give the lead a name")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(leadsClient.create).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Name"), "A");
    await userEvent.type(screen.getByLabelText("Email"), "bad@x");
    await userEvent.click(screen.getByRole("button", { name: "Create lead" }));
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
  });

  it("offers an owner picker only to someone who may assign", () => {
    open();
    expect(screen.queryByLabelText("Owner")).not.toBeInTheDocument();
    open(creator([{ key: "leads.assign", scope: "all" }]));
    expect(screen.getByLabelText("Owner")).toBeInTheDocument();
  });

  it("offers Unassigned only to someone who may leave a lead unassigned", () => {
    open(creator([{ key: "leads.assign", scope: "team" }]));
    expect(screen.queryByRole("option", { name: "Unassigned" })).not.toBeInTheDocument();
  });

  it("fills the deal value from a package until the person types one", async () => {
    const cat = testCatalog();
    render(
      <CatalogProvider catalog={cat}>
        <NewLeadSheet session={creator()} onCreated={vi.fn()} onClose={vi.fn()} />
      </CatalogProvider>,
    );
    const product = cat.products[0]!;
    await userEvent.selectOptions(screen.getByLabelText("Package"), product.id);
    expect(screen.getByLabelText("Deal value")).toHaveValue(String(product.defaultValue));
  });
});
