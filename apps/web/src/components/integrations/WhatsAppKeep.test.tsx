import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationsView } from "@/lib/sheets/types";
import { whatsappClient } from "@/lib/whatsapp/client";
import { WhatsAppKeep } from "./WhatsAppKeep";

vi.mock("@/lib/whatsapp/client", () => ({ whatsappClient: { setKeepFiles: vi.fn(), keepPreview: vi.fn() } }));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const view = (keepFilesMonths: 3 | 6 | 12 | 24 | null) =>
  ({
    whatsapp: { enabled: true, available: true, inPlan: true, keepFilesMonths },
  }) as unknown as IntegrationsView;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(whatsappClient.setKeepFiles).mockImplementation(async (m) => ok(view(m)));
});

/** "Keep WhatsApp files" (2026-10-19): forever by default; a shorter window asks first, saying what goes. */
describe("keep WhatsApp files", () => {
  it("shortening asks first, with how many files go and about how much room, and that they don't come back", async () => {
    const onView = vi.fn();
    vi.mocked(whatsappClient.keepPreview).mockResolvedValue(ok({ files: 128, bytes: 1.2 * 1024 ** 3 }));
    render(<WhatsAppKeep months={null} onView={onView} />);
    expect(
      screen.getByText("Photos, voice notes and documents stay in LUME as long as their lead does."),
    ).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Keep WhatsApp files" }), "6 months");
    expect(whatsappClient.keepPreview).toHaveBeenCalledWith(6);
    const sheet = await screen.findByRole("dialog", { name: "Keep WhatsApp files for 6 months?" });
    expect(sheet).toHaveTextContent(
      "LUME removes 128 files older than that, about 1.2 GB, within the hour. The messages stay on their leads, and the files stay on the phone.",
    );
    expect(sheet).toHaveTextContent(
      "Files LUME removes don’t come back, even if you keep files longer later.",
    );
    expect(whatsappClient.setKeepFiles).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove older files" }));
    await waitFor(() => expect(whatsappClient.setKeepFiles).toHaveBeenCalledWith(6));
    expect(onView).toHaveBeenCalledWith(view(6));
    expect(toast).toHaveBeenCalledWith({ tone: "ok", title: "WhatsApp files are kept for 6 months" });
  });

  it("cancelling changes nothing", async () => {
    vi.mocked(whatsappClient.keepPreview).mockResolvedValue(ok({ files: 2, bytes: 100 }));
    render(<WhatsAppKeep months={12} onView={vi.fn()} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Keep WhatsApp files" }), "3 months");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(whatsappClient.setKeepFiles).not.toHaveBeenCalled();
  });

  it("nothing old enough to go: saved at once, no question", async () => {
    vi.mocked(whatsappClient.keepPreview).mockResolvedValue(ok({ files: 0, bytes: 0 }));
    render(<WhatsAppKeep months={null} onView={vi.fn()} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Keep WhatsApp files" }), "1 year");
    await waitFor(() => expect(whatsappClient.setKeepFiles).toHaveBeenCalledWith(12));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("longer, or forever: saved at once, nothing asked (nothing goes)", async () => {
    render(<WhatsAppKeep months={3} onView={vi.fn()} />);
    expect(screen.getByText("Older files go from LUME. They stay on the phone.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Keep WhatsApp files" }), "Forever");
    await waitFor(() => expect(whatsappClient.setKeepFiles).toHaveBeenCalledWith(null));
    expect(whatsappClient.keepPreview).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ tone: "ok", title: "WhatsApp files are kept forever" });
  });

  it("a refusal is said in words, and the choice stays as it was", async () => {
    vi.mocked(whatsappClient.setKeepFiles).mockResolvedValue({
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "You don't have access to this",
    } as never);
    render(<WhatsAppKeep months={null} onView={vi.fn()} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Keep WhatsApp files" }), "Forever");
    expect(whatsappClient.setKeepFiles).not.toHaveBeenCalled(); // already forever: nothing to save
    vi.mocked(whatsappClient.keepPreview).mockResolvedValue(ok({ files: 0, bytes: 0 }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Keep WhatsApp files" }), "2 years");
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have access to this");
    expect(screen.getByRole("combobox", { name: "Keep WhatsApp files" })).toHaveValue("");
  });
});
