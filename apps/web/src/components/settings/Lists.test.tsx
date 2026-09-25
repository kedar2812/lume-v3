import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCatalog } from "@/lib/leads/test-catalog";
import { listsClient } from "@/lib/settings/lists";
import { Lists } from "./Lists";

vi.mock("@/lib/settings/lists", () => ({
  listsClient: {
    createReason: vi.fn(),
    patchReason: vi.fn(),
    archiveReason: vi.fn(),
    createTag: vi.fn(),
    patchTag: vi.fn(),
    deleteTag: vi.fn(),
    createProduct: vi.fn(),
    patchProduct: vi.fn(),
    archiveProduct: vi.fn(),
  },
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const all = { reasons: true, tagsAndPackages: true };
const catalog = testCatalog({
  lostReasons: [
    { id: "r-price", label: "Price", position: 0 },
    { id: "r-time", label: "Timing", position: 1 },
    { id: "r-ghost", label: "No reply", position: 2 },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listsClient.createProduct).mockResolvedValue(
    ok({ product: { id: "pr-new", name: "Starter", defaultValue: 1500, currency: null } }),
  );
  vi.mocked(listsClient.createTag).mockResolvedValue(
    ok({ tag: { id: "t-vip", label: "VIP", color: "meet" } }),
  );
  vi.mocked(listsClient.createReason).mockResolvedValue(
    ok({ lostReason: { id: "r-new", label: "Went elsewhere", position: 3 } }),
  );
  vi.mocked(listsClient.patchReason).mockImplementation(async (id, patch) =>
    ok({ lostReason: { ...catalog.lostReasons.find((r) => r.id === id)!, ...patch } }),
  );
  vi.mocked(listsClient.patchTag).mockImplementation(async (id, patch) =>
    ok({ tag: { ...catalog.tags.find((t) => t.id === id)!, ...patch } }),
  );
  vi.mocked(listsClient.patchProduct).mockImplementation(async (id, patch) =>
    ok({ product: { ...catalog.products.find((p) => p.id === id)!, ...patch } }),
  );
  vi.mocked(listsClient.deleteTag).mockResolvedValue(ok(null));
  vi.mocked(listsClient.archiveProduct).mockResolvedValue(ok(null));
  vi.mocked(listsClient.archiveReason).mockResolvedValue(ok(null));
});

describe("Lists", () => {
  it("keeps three simple lists: reasons and tags by name, packages with a price in the business currency", async () => {
    render(<Lists catalog={catalog} manage={all} />);
    const packages = screen.getByRole("region", { name: "Packages" });
    await userEvent.click(within(packages).getByRole("button", { name: "Add a package" }));
    await userEvent.type(within(packages).getByLabelText("Package name"), "Starter");
    await userEvent.type(within(packages).getByLabelText("Price"), "1,500");
    expect(within(packages).getAllByText("AED").length).toBeGreaterThan(0);
    await userEvent.click(within(packages).getByRole("button", { name: "Add" }));
    expect(listsClient.createProduct).toHaveBeenCalledWith({ name: "Starter", defaultValue: 1500 });
    expect(await within(packages).findByText("Starter")).toBeInTheDocument();

    const tags = screen.getByRole("region", { name: "Tags" });
    await userEvent.type(within(tags).getByRole("textbox", { name: "New tag" }), "VIP{Enter}");
    expect(listsClient.createTag).toHaveBeenCalledWith({ label: "VIP", color: expect.any(String) });
  });

  it("refuses a price that isn't an amount", async () => {
    render(<Lists catalog={catalog} manage={all} />);
    const packages = screen.getByRole("region", { name: "Packages" });
    await userEvent.click(within(packages).getByRole("button", { name: "Add a package" }));
    await userEvent.type(within(packages).getByLabelText("Package name"), "Starter");
    await userEvent.type(within(packages).getByLabelText("Price"), "abc");
    await userEvent.click(within(packages).getByRole("button", { name: "Add" }));
    expect(within(packages).getByText("Enter an amount, like 1,500")).toBeInTheDocument();
    expect(listsClient.createProduct).not.toHaveBeenCalled();
  });

  it("changes a package's price where it's shown", async () => {
    render(<Lists catalog={catalog} manage={all} />);
    const price = screen.getByLabelText("Price of Signature 12-week");
    await userEvent.clear(price);
    await userEvent.type(price, "5,000");
    fireEvent.blur(price);
    expect(listsClient.patchProduct).toHaveBeenCalledWith("pr-sig", { defaultValue: 5000 });
  });

  it("reorders lost reasons, saving only the ones that moved", async () => {
    render(<Lists catalog={catalog} manage={all} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Move Timing" }), { key: "ArrowUp", altKey: true });
    await vi.waitFor(() => expect(listsClient.patchReason).toHaveBeenCalledTimes(2));
    expect(listsClient.patchReason).toHaveBeenCalledWith("r-time", { position: 0 });
    expect(listsClient.patchReason).toHaveBeenCalledWith("r-price", { position: 1 });
  });

  it("recolours a tag, and removing one says it comes off every lead", async () => {
    render(<Lists catalog={catalog} manage={all} />);
    const tags = screen.getByRole("region", { name: "Tags" });
    await userEvent.click(within(tags).getByRole("button", { name: "Colour for Hot" }));
    await userEvent.click(screen.getByRole("radio", { name: "Violet" }));
    expect(listsClient.patchTag).toHaveBeenCalledWith("t-hot", { color: "meet" });
    await userEvent.click(within(tags).getByRole("button", { name: "Remove Hot" }));
    expect(within(tags).getByText(/comes off every lead/)).toBeInTheDocument();
    await userEvent.click(within(tags).getByRole("button", { name: "Remove" }));
    expect(listsClient.deleteTag).toHaveBeenCalledWith("t-hot");
  });

  it("shows only the lists this person can change", () => {
    render(<Lists catalog={catalog} manage={{ reasons: true, tagsAndPackages: false }} />);
    expect(screen.getByRole("region", { name: "Lost reasons" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Tags" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Packages" })).not.toBeInTheDocument();
  });

  it("shows the API's reason when a name is taken", async () => {
    vi.mocked(listsClient.createReason).mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "REASON_EXISTS",
      message: "That reason already exists",
    });
    render(<Lists catalog={catalog} manage={all} />);
    const reasons = screen.getByRole("region", { name: "Lost reasons" });
    await userEvent.type(within(reasons).getByRole("textbox", { name: "New reason" }), "Price{Enter}");
    expect(await within(reasons).findByRole("alert")).toHaveTextContent("That reason already exists");
  });
});
