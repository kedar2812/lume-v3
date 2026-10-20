import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filesClient, type LibraryFile } from "@/lib/files/client";
import { MediaScreen } from "./MediaScreen";

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
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

const file = (o: Partial<LibraryFile> & Pick<LibraryFile, "id" | "name">): LibraryFile => ({
  kind: "document",
  mime: "application/pdf",
  size: 2_516_582,
  link: { on: false, url: null, opens: 0 },
  createdAt: "2026-10-19T06:00:00.000Z",
  archived: false,
  viewAs: "pdf",
  preview: "ready",
  thumbUrl: `/api/v1/files/${o.id}/thumb?v=abcdef123456`,
  pages: 12,
  durationMs: null,
  width: 612,
  height: 792,
  ...o,
});
const BROCHURE = file({
  id: "f1",
  name: "Brochure 2026.pdf",
  link: { on: true, url: "https://crm.example.com/f/x", opens: 3 },
});
const LIVING = file({
  id: "f2",
  name: "Living room.jpg",
  kind: "image",
  mime: "image/jpeg",
  viewAs: "image",
  size: 1_992_294,
  pages: null,
  width: 4032,
  height: 3024,
});
const VISIT = file({
  id: "f3",
  name: "Site visit.mp4",
  kind: "video",
  mime: "video/mp4",
  viewAs: "video",
  size: 9_856_614,
  pages: null,
  durationMs: 65_000,
});
const ALL = [BROCHURE, LIVING, VISIT];

const grid = () => screen.getByRole("list", { name: "Your media" });
const tile = (name: string) => within(grid()).getByRole("button", { name: new RegExp(`^${name}`) });
const dropFiles = (files: File[]) => {
  const page = screen.getByRole("region", { name: "Media" });
  const dataTransfer = { files, types: ["Files"], items: files.map(() => ({ kind: "file" })) };
  fireEvent.dragEnter(page, { dataTransfer });
  fireEvent.dragOver(page, { dataTransfer });
  fireEvent.drop(page, { dataTransfer });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(filesClient.list).mockResolvedValue(ok({ files: ALL }));
  vi.mocked(filesClient.putAwayGuide).mockResolvedValue(ok({}) as never);
});
afterEach(() => vi.useRealTimers());

describe("Media (plan 2026-10-20-media-tab, Task 6)", () => {
  it("a first visit shows the guide: three steps, each with an icon and no number; Got it puts it away for good", async () => {
    render(<MediaScreen initial={ALL} canManage guideSeen={false} />);
    const guide = screen.getByRole("region", { name: "How Media works" });
    const steps = within(guide).getAllByRole("listitem");
    expect(steps.map((s) => within(s).getByRole("heading").textContent)).toEqual([
      "Add a file",
      "Send it from a lead",
      "Or share a link",
    ]);
    for (const s of steps) {
      expect(s.querySelector("svg, img")).not.toBeNull();
      expect(s.textContent).not.toMatch(/^\s*\d/);
    }
    await userEvent.click(within(guide).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "How Media works" })).toBeNull());
    expect(filesClient.putAwayGuide).toHaveBeenCalledOnce();
  });

  it("someone who put the guide away doesn't see it again", () => {
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    expect(screen.queryByRole("region", { name: "How Media works" })).toBeNull();
  });

  it("each tile shows the file's own content, what it is in words, and Link on when it's shared", () => {
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    const b = tile("Brochure 2026.pdf");
    expect(b.querySelector("img")).toHaveAttribute("src", "/api/v1/files/f1/thumb?v=abcdef123456");
    expect(b).toHaveTextContent("PDF · 12 pages · 2.4 MB");
    expect(b).toHaveTextContent("Link on");
    expect(tile("Living room.jpg")).toHaveTextContent("Photo · 1.9 MB");
    expect(tile("Living room.jpg")).not.toHaveTextContent("Link on");
    expect(tile("Site visit.mp4")).toHaveTextContent("Video · 1:05 · 9.4 MB");
  });

  it("a tile whose preview is on its way says so, and shows the thumbnail once it's made", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const waiting = file({
      id: "f9",
      name: "Proposal.docx",
      viewAs: "office",
      preview: "pending",
      thumbUrl: null,
    });
    vi.mocked(filesClient.list).mockResolvedValue(
      ok({ files: [{ ...waiting, preview: "ready", thumbUrl: "/t9" }] }),
    );
    render(<MediaScreen initial={[waiting]} canManage guideSeen />);
    expect(tile("Proposal.docx")).toHaveTextContent("Preview on its way");
    expect(tile("Proposal.docx")).toHaveTextContent("Word");
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await waitFor(() => expect(tile("Proposal.docx").querySelector("img")).toHaveAttribute("src", "/t9"));
    expect(tile("Proposal.docx")).not.toHaveTextContent("Preview on its way");
  });

  it("nothing waiting: the page doesn't keep asking", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(filesClient.list).not.toHaveBeenCalled();
  });

  it("chips show Photos, Videos and Documents with their counts", async () => {
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    const show = screen.getByRole("radiogroup", { name: "Show" });
    expect(
      within(show)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["All3", "Photos1", "Videos1", "Documents1"]);
    await userEvent.click(within(show).getByRole("radio", { name: /Photos/ }));
    // The others leave with their exit animation.
    await waitFor(() =>
      expect(
        within(grid())
          .getAllByRole("button")
          .map((b) => b.getAttribute("aria-label")),
      ).toEqual([expect.stringMatching(/^Living room\.jpg/)]),
    );
  });

  it("search narrows by name, and says when nothing matches", async () => {
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search media" }), "visit");
    await waitFor(() => expect(within(grid()).getAllByRole("button")).toHaveLength(1));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search media" }), "zzz");
    expect(screen.getByText("Nothing in Media matches “visitzzz”.")).toBeInTheDocument();
  });

  it("files dropped anywhere on the page upload, each with its own progress, then become tiles", async () => {
    let finish: (() => void) | null = null;
    vi.mocked(filesClient.uploadWithProgress).mockImplementation((f: File, onProgress) => {
      onProgress(0.5);
      return new Promise((resolve) => {
        finish = () =>
          resolve(ok({ file: file({ id: "new", name: f.name, preview: "pending", thumbUrl: null }) }));
      });
    });
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    dropFiles([new File(["%PDF-1.7"], "Price list.pdf", { type: "application/pdf" })]);
    const ring = await screen.findByRole("progressbar", { name: "Uploading Price list.pdf" });
    expect(ring).toHaveAttribute("aria-valuenow", "50");
    await act(async () => finish!());
    await waitFor(() => expect(tile("Price list.pdf")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.queryByRole("progressbar", { name: "Uploading Price list.pdf" })).toBeNull(),
    );
  });

  it("a file LUME refuses says why, and the others still go in", async () => {
    vi.mocked(filesClient.uploadWithProgress).mockImplementation(async (f: File) =>
      f.name === "Plan.dwg"
        ? ({
            ok: false,
            status: 415,
            code: "FILE_TYPE",
            message: "LUME can send photos, videos and documents.",
          } as never)
        : ok({ file: file({ id: "ok1", name: f.name }) }),
    );
    render(<MediaScreen initial={ALL} canManage guideSeen />);
    dropFiles([new File(["x"], "Plan.dwg"), new File(["%PDF"], "Menu.pdf", { type: "application/pdf" })]);
    const tray = await screen.findByRole("region", { name: "Adding files" });
    await within(tray).findByText("LUME can send photos, videos and documents.");
    await waitFor(() => expect(tile("Menu.pdf")).toBeInTheDocument());
    await userEvent.click(within(tray).getByRole("button", { name: "Dismiss Plan.dwg" }));
    await waitFor(() => expect(screen.queryByText("LUME can send photos, videos and documents.")).toBeNull());
  });

  it("a rep sees Media and opens files, but can't add any", async () => {
    const onOpen = vi.fn();
    render(<MediaScreen initial={ALL} canManage={false} guideSeen onOpen={onOpen} />);
    expect(screen.queryByRole("button", { name: "Add media" })).toBeNull();
    dropFiles([new File(["%PDF"], "Menu.pdf")]);
    expect(filesClient.uploadWithProgress).not.toHaveBeenCalled();
    await userEvent.click(tile("Living room.jpg"));
    expect(onOpen).toHaveBeenCalledWith("f2");
  });

  it("nothing yet: the empty state says what goes here and how, with three icon steps", () => {
    render(<MediaScreen initial={[]} canManage guideSeen={false} />);
    expect(
      screen.getByRole("heading", { name: "Your brochures, photos and videos, in one place" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add your first file" })).toBeInTheDocument();
    const steps = within(screen.getByRole("list", { name: "How it works" })).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    for (const s of steps) expect(s.querySelector("svg, img")).not.toBeNull();
    // The guide is the empty state's job here: not shown twice.
    expect(screen.queryByRole("region", { name: "How Media works" })).toBeNull();
  });
});
