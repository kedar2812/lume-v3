import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { filesClient, type LibraryFile } from "@/lib/files/client";
import { MediaPicker } from "./MediaPicker";

vi.mock("@/lib/files/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/files/client")>()),
  filesClient: { list: vi.fn() },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const file = (o: Partial<LibraryFile> & Pick<LibraryFile, "id" | "name">): LibraryFile => ({
  kind: "image",
  mime: "image/jpeg",
  size: 1_992_294,
  link: { on: false, url: null, opens: 0 },
  createdAt: "2026-10-19T06:00:00.000Z",
  archived: false,
  viewAs: "image",
  preview: "ready",
  thumbUrl: `/thumb/${o.id}`,
  pages: null,
  durationMs: null,
  width: null,
  height: null,
  ...o,
});
const BROCHURE = file({
  id: "f1",
  name: "Brochure.pdf",
  kind: "document",
  mime: "application/pdf",
  viewAs: "pdf",
  size: 2_516_582,
});
const LIVING = file({ id: "f2", name: "Living room.jpg" });
const VISIT = file({
  id: "f3",
  name: "Site visit.mp4",
  kind: "video",
  mime: "video/mp4",
  viewAs: "video",
  preview: "pending",
  thumbUrl: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(filesClient.list).mockResolvedValue(ok({ files: [BROCHURE, LIVING, VISIT] }));
});

describe("picking from Media (plan 2026-10-20-media-tab, Task 9; canvas Composer)", () => {
  it("shows each file by its content, ticks the ones chosen, and attaches them together", async () => {
    const onPick = vi.fn();
    render(<MediaPicker multiple onPick={onPick} />);
    const grid = await screen.findByRole("listbox", { name: "Media" });
    expect(grid).toHaveAttribute("aria-multiselectable", "true");
    const brochure = within(grid).getByRole("option", { name: /Brochure\.pdf/ });
    expect(brochure.querySelector("img")).toHaveAttribute("src", "/thumb/f1");
    expect(
      within(grid)
        .getByRole("option", { name: /Site visit\.mp4/ })
        .querySelector("img"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Attach" })).toBeDisabled();
    await userEvent.click(brochure);
    await userEvent.click(within(grid).getByRole("option", { name: /Living room\.jpg/ }));
    expect(brochure).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("button", { name: "Attach 2 files" }));
    expect(onPick).toHaveBeenCalledWith([BROCHURE, LIVING]);
  });

  it("a second tap puts a file back", async () => {
    render(<MediaPicker multiple onPick={vi.fn()} />);
    const living = await screen.findByRole("option", { name: /Living room\.jpg/ });
    await userEvent.click(living);
    expect(screen.getByRole("button", { name: "Attach 1 file" })).toBeEnabled();
    await userEvent.click(living);
    expect(living).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "Attach" })).toBeDisabled();
  });

  it("one at a time: a tap picks it", async () => {
    const onPick = vi.fn();
    render(<MediaPicker onPick={onPick} />);
    await userEvent.click(await screen.findByRole("option", { name: /Brochure\.pdf/ }));
    expect(onPick).toHaveBeenCalledWith([BROCHURE]);
  });

  it("search narrows by name; only the kinds asked for are offered", async () => {
    render(<MediaPicker multiple kinds={["image", "video"]} onPick={vi.fn()} />);
    const grid = await screen.findByRole("listbox", { name: "Media" });
    expect(within(grid).queryByRole("option", { name: /Brochure/ })).toBeNull();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search Media" }), "visit");
    expect(within(grid).getAllByRole("option")).toHaveLength(1);
  });

  it("the keyboard: arrows move, Space chooses, Enter attaches", async () => {
    const onPick = vi.fn();
    render(<MediaPicker multiple onPick={onPick} />);
    await screen.findByRole("listbox", { name: "Media" });
    await userEvent.keyboard("{ArrowRight} ");
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith([LIVING]);
  });

  it("nothing in Media yet says where files come from, with a way there", async () => {
    vi.mocked(filesClient.list).mockResolvedValue(ok({ files: [] }));
    render(<MediaPicker multiple onPick={vi.fn()} />);
    expect(
      await screen.findByText("Nothing in Media yet. Files added there can be sent from here."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Media" })).toHaveAttribute("href", "/media");
  });
});
