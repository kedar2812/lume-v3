import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappClient } from "@/lib/whatsapp/client";
import { storageClient, type Storage } from "@/lib/settings/storage";
import { StoragePage } from "./StoragePage";

vi.mock("@/lib/settings/storage", () => ({
  storageClient: { get: vi.fn(), clean: vi.fn(), progress: vi.fn(), settings: vi.fn() },
  filesCsvUrl: (k: string[]) => `/api/v1/storage/clean-up/files.csv?kinds=${k.join(",")}`,
}));
const toast = vi.fn();
vi.mock("@/lib/whatsapp/client", () => ({ whatsappClient: { keepPreview: vi.fn() } }));
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const base: Storage = {
  disk: { total: 100 * GB, free: 18.2 * GB },
  kinds: [
    { key: "whatsapp", bytes: 38.2 * GB, files: 12410 },
    { key: "instagram", bytes: 14.6 * GB, files: 6902 },
    { key: "previews", bytes: 3.1 * GB, files: 9214 },
    { key: "library", bytes: 2.9 * GB, files: 214 },
    { key: "database", bytes: 8.1 * GB, files: 0 },
  ],
  other: 14.9 * GB,
  candidates: [
    { kind: "closed", bytes: 14.2 * GB, files: 3880 },
    { kind: "trash", bytes: 3.4 * GB, files: 912 },
    { kind: "previews", bytes: 3.1 * GB, files: 9214 },
    { kind: "library", bytes: 2.7 * GB, files: 41 },
    { kind: "old", bytes: 18.9 * GB, files: 5120 },
  ],
  measuredAt: "2026-11-23T10:00:00.000Z",
  settings: { keepFilesMonths: null, warnAtPct: 80 },
  running: null,
};
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(storageClient.get).mockResolvedValue(ok(base));
});

describe("Settings › Storage", () => {
  it("the disk in one line, what LUME can give back, and what's here", () => {
    render(<StoragePage initial={base} />);
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(screen.getByText("81.8 GB")).toBeInTheDocument();
    expect(screen.getByText("of 100 GB used")).toBeInTheDocument();
    expect(screen.getByText("Getting full")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LUME can give back 20.7 GB" })).toBeInTheDocument();
    const here = screen.getByRole("heading", { name: "What's here" }).closest("section")!;
    expect(within(here).getByText("WhatsApp files")).toBeInTheDocument();
    expect(within(here).getByText(/12,410 files/)).toBeInTheDocument();
    expect(within(here).getByText("38.2 GB")).toBeInTheDocument();
  });

  it("a disk LUME can't read: what LUME keeps, said plainly, and no bar", () => {
    render(<StoragePage initial={{ ...base, disk: null, other: null }} />);
    expect(screen.getByText(/can't read this disk's size/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /used/ })).toBeNull();
    expect(screen.queryByText("The rest of the server")).toBeNull();
  });

  it("nothing to give back: no suggestion; under the mark: plenty of room", () => {
    render(
      <StoragePage
        initial={{
          ...base,
          disk: { total: 100 * GB, free: 60 * GB },
          candidates: base.candidates.map((c) => ({ ...c, bytes: 0, files: 0 })),
        }}
      />,
    );
    expect(screen.queryByRole("heading", { name: /can give back/ })).toBeNull();
    expect(screen.getByText("Plenty of room")).toBeInTheDocument();
  });

  it("a shorter keep asks first, saying what goes, then saves; the mark saves as it changes", async () => {
    vi.mocked(whatsappClient.keepPreview).mockResolvedValue(ok({ files: 1240, bytes: 3 * GB }));
    vi.mocked(storageClient.settings).mockResolvedValue(
      ok({ settings: { keepFilesMonths: 6 as const, warnAtPct: 80 as const } }),
    );
    render(<StoragePage initial={base} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Keep chat files for/ }), "6");
    // One keystroke on a focused select must never clear files: nothing is saved until the admin says so.
    expect(storageClient.settings).not.toHaveBeenCalled();
    const ask = await screen.findByRole("dialog", { name: "Keep chat files for 6 months?" });
    expect(ask).toHaveTextContent("LUME removes 1,240 files older than that");
    expect(ask).toHaveTextContent("on the phone or in Instagram");
    await userEvent.click(within(ask).getByRole("button", { name: "Remove older files" }));
    expect(storageClient.settings).toHaveBeenCalledWith({ keepFilesMonths: 6 });
    expect(toast).toHaveBeenCalledWith({ tone: "ok", title: "Chat files are kept for 6 months" });
    vi.mocked(storageClient.settings).mockResolvedValue(
      ok({ settings: { keepFilesMonths: 6 as const, warnAtPct: 90 as const } }),
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Tell admins/ }), "90");
    expect(storageClient.settings).toHaveBeenCalledWith({ warnAtPct: 90 });
    expect(toast).toHaveBeenCalledWith({ tone: "ok", title: "Saved" });
  });
});

describe("Clean up's sheet", () => {
  it("ticks what no lead being worked needs; the total and the button follow the boxes; the old-files warning only when ticked", async () => {
    render(<StoragePage initial={base} />);
    await userEvent.click(screen.getByRole("button", { name: /Clean up/ }));
    const sheet = screen.getByRole("dialog", { name: "Clean up" });
    const box = (name: RegExp) => within(sheet).getByRole("checkbox", { name });
    expect(box(/closed over 6 months/)).toBeChecked();
    expect(box(/in the trash/)).toBeChecked();
    expect(box(/Previews/)).toBeChecked();
    expect(box(/Archived library/)).not.toBeChecked();
    expect(box(/older than 12 months/)).not.toBeChecked();
    expect(within(sheet).getByRole("button", { name: "Clear 20.7 GB" })).toBeEnabled();
    expect(within(sheet).queryByText(/still working/)).toBeNull();
    await userEvent.click(box(/older than 12 months/));
    expect(within(sheet).getByText("This includes leads your team is still working.")).toBeInTheDocument();
    // Old files reach open leads: the sheet stops promising they're never cleared.
    expect(within(sheet).getByText(/^Never cleared/)).not.toHaveTextContent("files on leads still open");
    for (const name of [/closed over 6 months/, /in the trash/, /Previews/, /older than 12 months/])
      await userEvent.click(box(name));
    expect(within(sheet).getByRole("button", { name: "Tick something to clear" })).toBeDisabled();
    expect(within(sheet).queryByRole("link", { name: "List the files first" })).toBeNull();
  });

  it("Clear runs the morph to the end, and the page reads its numbers again", async () => {
    const running = {
      id: "c1",
      kinds: ["closed" as const],
      status: "running" as const,
      filesPlanned: 3880,
      bytesPlanned: 14.2 * GB,
      filesDone: 0,
      bytesDone: 0,
      startedAt: base.measuredAt,
      finishedAt: null,
      problem: null,
    };
    vi.mocked(storageClient.clean).mockResolvedValue({ ...ok(running), status: 202 });
    vi.mocked(storageClient.progress).mockResolvedValue(
      ok({ ...running, status: "done", filesDone: 3880, bytesDone: 14.2 * GB }),
    );
    render(<StoragePage initial={base} />);
    await userEvent.click(screen.getByRole("button", { name: /Clean up/ }));
    const sheet = screen.getByRole("dialog", { name: "Clean up" });
    for (const name of [/in the trash/, /Previews/])
      await userEvent.click(within(sheet).getByRole("checkbox", { name }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Clear 14.2 GB" }));
    // The button lifts first (Refresh's beat), then LUME asks to clear.
    await waitFor(() => expect(storageClient.clean).toHaveBeenCalledWith(["closed"]));
    await waitFor(
      () => expect(screen.getByRole("status")).toHaveTextContent("14.2 GB back on this server."),
      {
        timeout: 6000,
      },
    );
    await waitFor(() => expect(storageClient.get).toHaveBeenCalled());
    await act(async () => undefined);
    void MB;
  }, 12_000);
});
