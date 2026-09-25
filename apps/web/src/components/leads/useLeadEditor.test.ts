import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { testCatalog, testLead as lead } from "@/lib/leads/test-catalog";
import { CatalogProvider } from "./CatalogProvider";
import { editable, patchFor, useLeadEditor } from "./useLeadEditor";

vi.mock("@/lib/leads/client", () => ({ leadsClient: { patch: vi.fn(), get: vi.fn() } }));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
const cat = testCatalog();
const field = (key: string) => cat.fields.find((f) => f.key === key)!;
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(CatalogProvider, { catalog: cat, children });

beforeEach(() => {
  vi.mocked(leadsClient.patch).mockReset();
  vi.mocked(leadsClient.get).mockReset();
  toast.mockReset();
});

describe("patchFor", () => {
  it("puts core fields at the top level and custom fields under custom, with empty clearing", () => {
    expect(patchFor(field("name"), "Aisha K")).toEqual({ name: "Aisha K" });
    expect(patchFor(field("value"), 5000)).toEqual({ value: 5000 });
    expect(patchFor(field("struggles"), ["o1"])).toEqual({ custom: { struggles: ["o1"] } });
    expect(patchFor(field("struggles"), [])).toEqual({ custom: { struggles: null } });
    expect(patchFor(field("email"), "")).toEqual({ email: null });
  });
});

describe("editable", () => {
  it("needs the lead's edit right, edit access to the field, and a visible contact for contact fields", () => {
    expect(editable(lead(), field("name"))).toBe(true);
    expect(editable(lead({ can: { ...lead().can, edit: false } }), field("name"))).toBe(false);
    expect(editable(lead(), { ...field("name"), access: "view" })).toBe(false);
    expect(editable(lead(), { ...field("name"), archived: true })).toBe(false);
    expect(editable(lead({ contactMasked: true }), field("phone"))).toBe(false);
    expect(editable(lead({ contactMasked: false }), field("phone"))).toBe(true);
  });
});

describe("useLeadEditor", () => {
  it("saves with the version it saw and hands back the new lead", async () => {
    const onUpdated = vi.fn();
    vi.mocked(leadsClient.patch).mockResolvedValue({
      ok: true,
      status: 200,
      data: { lead: lead({ name: "Aisha K", version: 2 }) },
    });
    const { result } = renderHook(() => useLeadEditor(onUpdated), { wrapper });
    await act(async () => expect(await result.current.save(lead(), field("name"), "Aisha K")).toBe("ok"));
    expect(leadsClient.patch).toHaveBeenCalledWith("l1", 1, { name: "Aisha K" });
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ name: "Aisha K", version: 2 }));
  });

  it("never overwrites someone else's change: reloads the lead and says so", async () => {
    const onUpdated = vi.fn();
    vi.mocked(leadsClient.patch).mockResolvedValue({
      ok: false,
      status: 409,
      code: "VERSION_CONFLICT",
      message: "x",
    });
    vi.mocked(leadsClient.get).mockResolvedValue({
      ok: true,
      status: 200,
      data: { lead: lead({ name: "Aisha (by Tasneem)", version: 5 }) },
    });
    const { result } = renderHook(() => useLeadEditor(onUpdated), { wrapper });
    await act(async () => expect(await result.current.save(lead(), field("name"), "Mine")).toBe("conflict"));
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Aisha (by Tasneem)", version: 5 }),
    );
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/changed by someone else/i) }),
    );
  });

  it("keeps the editor open with the reason when the value is refused", async () => {
    vi.mocked(leadsClient.patch).mockResolvedValue({
      ok: false,
      status: 400,
      code: "VALIDATION_FAILED",
      message: "Request is invalid",
      details: [{ instancePath: "/email", message: "Invalid email address" }],
    });
    const { result } = renderHook(() => useLeadEditor(vi.fn()), { wrapper });
    await act(async () => expect(await result.current.save(lead(), field("email"), "nope")).toBe("invalid"));
    expect(result.current.error).toEqual({
      leadId: "l1",
      key: "email",
      message: "Enter a valid email address",
    });
  });

  it("says so when the save fails for another reason, without pretending it worked", async () => {
    const onUpdated = vi.fn();
    vi.mocked(leadsClient.patch).mockResolvedValue({
      ok: false,
      status: 0,
      code: "OFFLINE",
      message: "offline",
    });
    const { result } = renderHook(() => useLeadEditor(onUpdated), { wrapper });
    await act(async () => expect(await result.current.save(lead(), field("name"), "X")).toBe("failed"));
    expect(onUpdated).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "danger" }));
  });
});
