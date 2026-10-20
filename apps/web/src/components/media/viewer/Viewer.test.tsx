import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { filesClient, type LibraryFile } from "@/lib/files/client";
import { MediaScreen } from "../MediaScreen";

const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
vi.mock("@/components/ZoneProvider", () => ({ useZone: () => "Asia/Kolkata" }));
vi.mock("@/lib/files/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/files/client")>()),
  filesClient: {
    list: vi.fn(),
    upload: vi.fn(),
    uploadWithProgress: vi.fn(),
    rename: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    setLink: vi.fn(),
    retryPreview: vi.fn(),
    putAwayGuide: vi.fn(),
  },
}));
// The PDF and sheet views load their libraries; these tests are about the viewer around them.
vi.mock("./PdfView", () => ({ PdfView: ({ src }: { src: string }) => <div data-testid="pdf">{src}</div> }));
vi.mock("./SheetView", () => ({
  SheetView: ({ src }: { src: string }) => <div data-testid="sheet">{src}</div>,
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
  width: 4032,
  height: 3024,
  ...o,
});
// Newest first on the page: Living room, Kitchen, Visit.
const LIVING = file({ id: "f1", name: "Living room.jpg", createdAt: "2026-10-19T09:00:00.000Z" });
const KITCHEN = file({
  id: "f2",
  name: "Kitchen.png",
  mime: "image/png",
  createdAt: "2026-10-19T08:00:00.000Z",
});
const VISIT = file({
  id: "f3",
  name: "Site visit.mp4",
  kind: "video",
  mime: "video/mp4",
  viewAs: "video",
  durationMs: 65_000,
  width: 1920,
  height: 1080,
  createdAt: "2026-10-19T07:00:00.000Z",
});
const ALL = [LIVING, KITCHEN, VISIT];

const viewer = () => screen.getByRole("dialog");
const openTile = async (name: string) =>
  userEvent.click(
    within(screen.getByRole("list", { name: "Your media" })).getByRole("button", {
      name: new RegExp(`^${name}`),
    }),
  );

beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: vi.fn() });
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(filesClient.list).mockResolvedValue(ok({ files: ALL }));
});

describe("LUME's own viewer (plan 2026-10-20-media-tab, Task 7)", () => {
  it("opens the file it was asked for, in LUME, and Escape gives focus back to its tile", async () => {
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    await openTile("Kitchen.png");
    expect(viewer()).toHaveAccessibleName("Kitchen.png");
    expect(viewer()).toHaveAttribute("aria-modal", "true");
    expect(within(viewer()).getByRole("img", { name: "Kitchen.png" })).toHaveAttribute(
      "src",
      "/api/v1/files/f2/content",
    );
    expect(within(viewer()).getByText("Photo · 4032 × 3024 · 1.9 MB")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-viewer-origin", "f2"));
  });

  it("Left and Right move between files in the page's order, and the ends say so instead of wrapping", async () => {
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    await openTile("Living room.jpg");
    await userEvent.keyboard("{ArrowLeft}");
    expect(viewer()).toHaveAccessibleName("Living room.jpg");
    expect(screen.getByRole("status")).toHaveTextContent("This is the first file.");
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(viewer()).toHaveAccessibleName("Kitchen.png"));
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(viewer()).toHaveAccessibleName("Site visit.mp4"));
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("status")).toHaveTextContent("This is the last file.");
    expect(viewer()).toHaveAccessibleName("Site visit.mp4");
  });

  it("the buttons and the strip move between files too", async () => {
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    await openTile("Living room.jpg");
    expect(within(viewer()).getByRole("button", { name: "Previous file" })).toBeDisabled();
    await userEvent.click(within(viewer()).getByRole("button", { name: "Next file" }));
    await waitFor(() => expect(viewer()).toHaveAccessibleName("Kitchen.png"));
    const strip = within(viewer()).getByRole("navigation", { name: "Other media" });
    await userEvent.click(within(strip).getByRole("button", { name: "Site visit.mp4" }));
    await waitFor(() => expect(viewer()).toHaveAccessibleName("Site visit.mp4"));
    expect(within(strip).getByRole("button", { name: "Site visit.mp4" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("Info shows where it goes, Share by link, rename and archive to an admin", async () => {
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    await openTile("Living room.jpg");
    await userEvent.click(within(viewer()).getByRole("button", { name: "Info" }));
    const info = within(viewer()).getByRole("complementary", { name: "Info" });
    expect(within(info).getByText(/Sends as the real file from any lead's WhatsApp tab/)).toBeInTheDocument();
    expect(within(info).getByRole("switch", { name: "Share Living room.jpg by link" })).toBeInTheDocument();
    expect(within(info).getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(within(info).getByRole("button", { name: "Archive" })).toBeInTheDocument();
    // "i" puts it away again.
    await userEvent.keyboard("i");
    await waitFor(() => expect(within(viewer()).queryByRole("complementary", { name: "Info" })).toBeNull());
  });

  it("a rep sees where it goes and a link that's on, and nothing to change", async () => {
    const shared = { ...LIVING, link: { on: true, url: "https://crm.example.com/f/abc", opens: 4 } };
    render(<MediaScreen initial={[shared]} canManage={false} guideSeen />);
    await openTile("Living room.jpg");
    await userEvent.click(within(viewer()).getByRole("button", { name: "Info" }));
    const info = within(viewer()).getByRole("complementary", { name: "Info" });
    expect(within(info).getByText(/Sends as the real file/)).toBeInTheDocument();
    expect(within(info).queryByRole("switch")).toBeNull();
    expect(
      within(info).getByRole("button", { name: "Copy the link to Living room.jpg" }),
    ).toBeInTheDocument();
    expect(within(info).queryByRole("button", { name: "Rename" })).toBeNull();
    expect(within(info).queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("Share by link: on shows the link to copy; the tile says Link on", async () => {
    vi.mocked(filesClient.setLink).mockResolvedValue(
      ok({ file: { ...LIVING, link: { on: true, url: "https://crm.example.com/f/abc", opens: 0 } } }),
    );
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    await openTile("Living room.jpg");
    await userEvent.click(within(viewer()).getByRole("button", { name: "Info" }));
    await userEvent.click(within(viewer()).getByRole("switch", { name: "Share Living room.jpg by link" }));
    expect(filesClient.setLink).toHaveBeenCalledWith("f1", true);
    expect(await within(viewer()).findByText("https://crm.example.com/f/abc")).toBeInTheDocument();
    expect(within(viewer()).getByText("Not opened yet")).toBeInTheDocument();
  });

  it("rename in place: Enter saves, Escape keeps the name it had", async () => {
    vi.mocked(filesClient.rename).mockResolvedValue(
      ok({ file: { ...LIVING, name: "Living room, finished.jpg" } }),
    );
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    await openTile("Living room.jpg");
    await userEvent.click(within(viewer()).getByRole("button", { name: "Info" }));
    await userEvent.click(within(viewer()).getByRole("button", { name: "Rename" }));
    const box = within(viewer()).getByRole("textbox", { name: "Name of Living room.jpg" });
    await userEvent.keyboard("{Escape}");
    expect(box).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Living room.jpg");
    await userEvent.click(within(viewer()).getByRole("button", { name: "Rename" }));
    const again = within(viewer()).getByRole("textbox", { name: "Name of Living room.jpg" });
    await userEvent.clear(again);
    await userEvent.type(again, "Living room, finished.jpg{Enter}");
    expect(filesClient.rename).toHaveBeenCalledWith("f1", "Living room, finished.jpg");
    await waitFor(() => expect(viewer()).toHaveAccessibleName("Living room, finished.jpg"));
  });

  it("Archive moves on to the next file, and Undo is offered", async () => {
    vi.mocked(filesClient.archive).mockResolvedValue(ok({ file: { ...LIVING, archived: true } }));
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    await openTile("Living room.jpg");
    await userEvent.click(within(viewer()).getByRole("button", { name: "Info" }));
    await userEvent.click(within(viewer()).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(viewer()).toHaveAccessibleName("Kitchen.png"));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Living room.jpg archived",
        action: expect.objectContaining({ label: "Undo" }),
      }),
    );
  });

  it("a video plays inline with LUME's own controls", async () => {
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    await openTile("Site visit.mp4");
    const video = viewer().querySelector("video")!;
    expect(video).toHaveAttribute("src", "/api/v1/files/f3/content");
    expect(video).toHaveAttribute("playsinline");
    expect(video.controls).toBe(false);
    await userEvent.click(within(viewer()).getByRole("button", { name: "Play" }));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    act(() => void fireEvent(video, new Event("play")));
    expect(within(viewer()).getByRole("button", { name: "Pause" })).toBeInTheDocument();
    const position = within(viewer()).getByRole("slider", { name: "Position" });
    expect(position).toHaveAttribute("aria-valuetext", "0:00 of 1:05");
    for (const name of ["Back 10 seconds", "Sound off", "Full screen"])
      expect(within(viewer()).getByRole("button", { name })).toBeInTheDocument();
  });

  it("a photo zooms from the pointer with a pinch or Ctrl and the wheel; a double-click fits it again", async () => {
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    await openTile("Living room.jpg");
    const zoom = within(viewer()).getByRole("group", { name: "Zoom" });
    expect(zoom).toHaveTextContent("Fit");
    const stage = within(viewer()).getByRole("img", { name: "Living room.jpg" });
    fireEvent.wheel(stage, { deltaY: -200, ctrlKey: true, clientX: 100, clientY: 100 });
    await waitFor(() => expect(zoom).not.toHaveTextContent("Fit"));
    fireEvent.doubleClick(stage, { clientX: 100, clientY: 100 });
    await waitFor(() => expect(zoom).toHaveTextContent("Fit"));
    await userEvent.click(within(zoom).getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(zoom).toHaveTextContent("150%"));
  });

  it("a Word file with its pages made opens them; one being made says so; without a render service it says what it can do", async () => {
    const word = (preview: LibraryFile["preview"]) =>
      file({
        id: `w-${preview}`,
        name: `Proposal ${preview}.docx`,
        kind: "document",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        viewAs: "office",
        preview,
      });
    const words = [word("ready"), word("pending"), word("none")];
    vi.mocked(filesClient.list).mockResolvedValue(ok({ files: words }));
    render(<MediaScreen initial={words} canManage guideSeen />);
    // Added together, they sit by name: none, pending, ready.
    await openTile("Proposal ready.docx");
    expect(within(viewer()).getByTestId("pdf")).toHaveTextContent("/api/v1/files/w-ready/pdf");
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(viewer()).toHaveAccessibleName("Proposal pending.docx"));
    expect(
      within(viewer()).getByText("LUME is making this file's pages. They'll be here in a moment."),
    ).toBeInTheDocument();
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(viewer()).toHaveAccessibleName("Proposal none.docx"));
    expect(
      within(viewer()).getByText(/This server can't show Word and PowerPoint files yet/),
    ).toBeInTheDocument();
  });
});
