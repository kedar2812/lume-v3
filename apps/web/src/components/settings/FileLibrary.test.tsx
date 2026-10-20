import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { filesClient, type LibraryFile } from "@/lib/files/client";
import { FileLibrary } from "./FileLibrary";
import { NO_PREVIEW } from "@/lib/files/testing";

const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
vi.mock("@/components/ZoneProvider", () => ({ useZone: () => "Asia/Kolkata" }));
vi.mock("@/lib/files/client", () => ({
  filesClient: {
    list: vi.fn(),
    upload: vi.fn(),
    rename: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    setLink: vi.fn(),
  },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const URL_ON = "https://crm.example.com/f/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const file = (o: Partial<LibraryFile> & Pick<LibraryFile, "id" | "name">): LibraryFile => ({
  kind: "document",
  mime: "application/pdf",
  size: 1_258_291,
  link: { on: false, url: null, opens: 0 },
  createdAt: "2026-10-19T06:00:00.000Z",
  archived: false,
  ...NO_PREVIEW,
  ...o,
});
const BROCHURE = file({ id: "f1", name: "Brochure.pdf" });
const row = (name: string) => screen.getByRole("listitem", { name });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(filesClient.list).mockImplementation(async (archived = false) =>
    ok({ files: archived ? [] : [BROCHURE] }),
  );
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("Settings → Files (plan W3b-1 Task 5)", () => {
  it("lists the business's files with what each is and its size", async () => {
    render(<FileLibrary />);
    const r = await screen.findByRole("listitem", { name: "Brochure.pdf" });
    expect(r).toHaveTextContent("PDF · 1.2 MB · Added Oct 19");
  });

  it("chosen files each show uploading, then their row; a refused one says why and the others stay", async () => {
    let finish: () => void = () => undefined;
    vi.mocked(filesClient.upload).mockImplementation((f: File) =>
      f.name === "fake.pdf"
        ? Promise.resolve({
            ok: false,
            status: 415,
            code: "FILE_TYPE",
            message:
              "LUME can send photos (JPEG, PNG), videos (MP4), voice notes and documents (PDF, Word, Excel, PowerPoint, text).",
          } as never)
        : new Promise((r) => {
            finish = () =>
              r(
                ok({
                  file: file({ id: "f2", name: "Office.jpg", kind: "image", mime: "image/jpeg", size: 2048 }),
                }),
              );
          }),
    );
    render(<FileLibrary />);
    await screen.findByRole("listitem", { name: "Brochure.pdf" });
    await userEvent.upload(screen.getByLabelText("Choose files"), [
      new File(["x"], "Office.jpg", { type: "image/jpeg" }),
      new File(["<html>"], "fake.pdf", { type: "application/pdf" }),
    ]);
    expect(await screen.findByText("Uploading…")).toBeInTheDocument();
    expect(await screen.findByText(/LUME can send photos/)).toBeInTheDocument();
    finish();
    expect(await screen.findByRole("listitem", { name: "Office.jpg" })).toHaveTextContent("Photo · 2 KB");
    expect(screen.queryByText("Uploading…")).toBeNull();
    expect(screen.getByRole("listitem", { name: "Brochure.pdf" })).toBeInTheDocument();
    expect(screen.getByText(/LUME can send photos/)).toBeInTheDocument();
  });

  it("files dropped on the page upload too", async () => {
    vi.mocked(filesClient.upload).mockResolvedValue(ok({ file: file({ id: "f3", name: "Menu.pdf" }) }));
    render(<FileLibrary />);
    await screen.findByRole("listitem", { name: "Brochure.pdf" });
    const drop = screen.getByRole("region", { name: "Add files" });
    fireEvent.drop(drop, { dataTransfer: { files: [new File(["%PDF"], "Menu.pdf")], types: ["Files"] } });
    expect(await screen.findByRole("listitem", { name: "Menu.pdf" })).toBeInTheDocument();
  });

  it("renames in place: Enter saves, Escape keeps the old name", async () => {
    vi.mocked(filesClient.rename).mockResolvedValue(ok({ file: { ...BROCHURE, name: "Brochure 2026.pdf" } }));
    render(<FileLibrary />);
    await screen.findByRole("listitem", { name: "Brochure.pdf" });
    await userEvent.click(screen.getByRole("button", { name: "Rename Brochure.pdf" }));
    const box = screen.getByRole("textbox", { name: "Name of Brochure.pdf" });
    await userEvent.clear(box);
    await userEvent.type(box, "Draft{Escape}");
    expect(filesClient.rename).not.toHaveBeenCalled();
    expect(row("Brochure.pdf")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Rename Brochure.pdf" }));
    const again = screen.getByRole("textbox", { name: "Name of Brochure.pdf" });
    await userEvent.clear(again);
    await userEvent.type(again, "Brochure 2026.pdf{Enter}");
    expect(filesClient.rename).toHaveBeenCalledWith("f1", "Brochure 2026.pdf");
    expect(await screen.findByRole("listitem", { name: "Brochure 2026.pdf" })).toBeInTheDocument();
  });

  it("a name already taken says so, and the box stays open to change it", async () => {
    vi.mocked(filesClient.rename).mockResolvedValue({
      ok: false,
      status: 409,
      code: "NAME_TAKEN",
      message: "A file called “Menu.pdf” is already in your files.",
    } as never);
    render(<FileLibrary />);
    await screen.findByRole("listitem", { name: "Brochure.pdf" });
    await userEvent.click(screen.getByRole("button", { name: "Rename Brochure.pdf" }));
    const box = screen.getByRole("textbox", { name: "Name of Brochure.pdf" });
    await userEvent.clear(box);
    await userEvent.type(box, "Menu.pdf{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A file called “Menu.pdf” is already in your files.",
    );
    expect(screen.getByRole("textbox", { name: "Name of Brochure.pdf" })).toHaveValue("Menu.pdf");
  });

  it("Share by link: on shows the link with Copy and how often it was opened; off says the old link shows nothing", async () => {
    vi.mocked(filesClient.setLink)
      .mockResolvedValueOnce(ok({ file: { ...BROCHURE, link: { on: true, url: URL_ON, opens: 3 } } }))
      .mockResolvedValueOnce(ok({ file: { ...BROCHURE, link: { on: false, url: null, opens: 3 } } }));
    render(<FileLibrary />);
    await screen.findByRole("listitem", { name: "Brochure.pdf" });
    await userEvent.click(screen.getByRole("switch", { name: "Share Brochure.pdf by link" }));
    expect(filesClient.setLink).toHaveBeenCalledWith("f1", true);
    const r = row("Brochure.pdf");
    expect(await within(r).findByText(URL_ON)).toBeInTheDocument();
    expect(r).toHaveTextContent("Opened 3 times");
    await userEvent.click(within(r).getByRole("button", { name: "Copy the link to Brochure.pdf" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(URL_ON);
    expect(within(r).getByRole("button", { name: "Copy the link to Brochure.pdf" })).toHaveTextContent(
      "Copied",
    );
    await userEvent.click(screen.getByRole("switch", { name: "Share Brochure.pdf by link" }));
    expect(await within(r).findByText("Anyone with the old link now sees nothing.")).toBeInTheDocument();
    expect(within(r).queryByText(URL_ON)).toBeNull();
  });

  it("archives with Undo in the toast; Undo puts it back", async () => {
    vi.mocked(filesClient.archive).mockResolvedValue(ok({ file: { ...BROCHURE, archived: true } }));
    vi.mocked(filesClient.restore).mockResolvedValue(ok({ file: BROCHURE }));
    render(<FileLibrary />);
    await screen.findByRole("listitem", { name: "Brochure.pdf" });
    await userEvent.click(screen.getByRole("button", { name: "Archive Brochure.pdf" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Brochure.pdf" })).toBeNull());
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Brochure.pdf archived",
        detail: "Messages that already sent it keep it.",
        action: expect.objectContaining({ label: "Undo" }),
      }),
    );
    toast.mock.calls[0]![0].action.onClick();
    expect(filesClient.restore).toHaveBeenCalledWith("f1");
    expect(await screen.findByRole("listitem", { name: "Brochure.pdf" })).toBeInTheDocument();
  });

  it("archived files can be shown and restored later", async () => {
    vi.mocked(filesClient.list).mockImplementation(async (archived = false) =>
      ok({ files: archived ? [file({ id: "f9", name: "Old menu.pdf", archived: true })] : [BROCHURE] }),
    );
    vi.mocked(filesClient.restore).mockResolvedValue(ok({ file: file({ id: "f9", name: "Old menu.pdf" }) }));
    render(<FileLibrary />);
    await screen.findByRole("listitem", { name: "Brochure.pdf" });
    await userEvent.click(screen.getByRole("button", { name: "Show archived files" }));
    await userEvent.click(await screen.findByRole("button", { name: "Restore Old menu.pdf" }));
    expect(filesClient.restore).toHaveBeenCalledWith("f9");
    expect(await screen.findByRole("listitem", { name: "Old menu.pdf" })).toBeInTheDocument();
  });

  it("no files yet says what they're for", async () => {
    vi.mocked(filesClient.list).mockResolvedValue(ok({ files: [] }));
    render(<FileLibrary />);
    expect(await screen.findByText("No files yet")).toBeInTheDocument();
    expect(
      screen.getByText("Add a brochure, price list or photo once, then send it from any lead's WhatsApp."),
    ).toBeInTheDocument();
  });
});
