import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { filesClient, type LibraryFile } from "@/lib/files/client";
import { FilePicker } from "./FilePicker";

vi.mock("@/lib/files/client", () => ({ filesClient: { list: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const file = (o: Partial<LibraryFile> & Pick<LibraryFile, "id" | "name">): LibraryFile => ({
  kind: "document",
  mime: "application/pdf",
  size: 1_258_291,
  link: { on: false, url: null, opens: 0 },
  createdAt: "2026-10-19T06:00:00.000Z",
  archived: false,
  ...o,
});
const FILES = [
  file({ id: "f1", name: "Brochure.pdf" }),
  file({ id: "f2", name: "Price list 2026.pdf", size: 204_800 }),
  file({ id: "f3", name: "Office front.jpg", kind: "image", mime: "image/jpeg", size: 2_097_152 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(filesClient.list).mockResolvedValue(ok({ files: FILES }));
});

describe("choosing a file from the business's files (plan W3b-1 Task 4)", () => {
  it("lists each file with its type and size; a search narrows by name; a pick hands the file back", async () => {
    const onPick = vi.fn();
    render(<FilePicker onPick={onPick} />);
    expect(await screen.findByRole("option", { name: /Brochure\.pdf/ })).toHaveTextContent("PDF · 1.2 MB");
    expect(screen.getByRole("option", { name: /Office front\.jpg/ })).toHaveTextContent("Photo · 2 MB");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search your files" }), "price");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("Price list 2026.pdf"),
    ]);
    await userEvent.click(screen.getByRole("option", { name: /Price list 2026\.pdf/ }));
    expect(onPick).toHaveBeenCalledWith(FILES[1]);
  });

  it("arrows choose and Enter picks, from the search box", async () => {
    const onPick = vi.fn();
    render(<FilePicker onPick={onPick} />);
    await screen.findByRole("option", { name: /Brochure\.pdf/ });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search your files" }), "{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith(FILES[1]);
  });

  it("only the kinds asked for", async () => {
    render(<FilePicker kinds={["image"]} onPick={vi.fn()} />);
    expect(await screen.findByRole("option", { name: /Office front\.jpg/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Brochure\.pdf/ })).toBeNull();
  });

  it("no files yet says where they come from; a search that finds nothing says so", async () => {
    vi.mocked(filesClient.list).mockResolvedValueOnce(ok({ files: [] }));
    const { unmount } = render(<FilePicker onPick={vi.fn()} />);
    expect(
      await screen.findByText("No files yet. An admin adds them in Settings, under Files."),
    ).toBeInTheDocument();
    unmount();
    render(<FilePicker onPick={vi.fn()} />);
    await screen.findByRole("option", { name: /Brochure\.pdf/ });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search your files" }), "zz");
    expect(screen.getByText("No file matches “zz”")).toBeInTheDocument();
  });

  it("files LUME couldn't load say why", async () => {
    vi.mocked(filesClient.list).mockResolvedValueOnce({
      ok: false,
      status: 0,
      code: "OFFLINE",
      message: "You're offline.",
    } as never);
    render(<FilePicker onPick={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You're offline.");
  });
});
