import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappClient } from "@/lib/whatsapp/client";
import { WhatsAppConnected } from "./WhatsAppConnected";

let search = new URLSearchParams({ p: "sealed", s: "sig" });
const replace = vi.fn();
const toast = vi.fn();
vi.mock("next/navigation", () => ({ useSearchParams: () => search, useRouter: () => ({ replace }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
vi.mock("@/lib/whatsapp/client", () => ({ whatsappClient: { complete: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
beforeEach(() => {
  vi.clearAllMocks();
  search = new URLSearchParams({ p: "sealed", s: "sig" });
});

describe("back from Meta (spec 2026-10-18 §3.2)", () => {
  it("finishes the hand-back once, says which number, and goes back to Integrations", async () => {
    vi.mocked(whatsappClient.complete).mockResolvedValue(
      ok({
        numbers: [
          {
            id: "n1",
            display: "+91 90000 00001",
            name: "Harbour Studio",
            owner: null,
            status: "active" as const,
            problem: null,
            historyShared: true,
            connectedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    window.history.replaceState(null, "", "/settings/integrations/whatsapp/connected?p=sealed&s=sig");
    render(<WhatsAppConnected />);
    expect(whatsappClient.complete).toHaveBeenCalledWith({ p: "sealed", s: "sig" });
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/settings/integrations"));
    expect(toast).toHaveBeenCalledWith({
      tone: "ok",
      title: "WhatsApp connected",
      detail: "+91 90000 00001",
      // WhatsApp's own app icon, as everywhere else LUME shows WhatsApp.
      mark: { src: "/brand/whatsapp-app.png", alt: "" },
    });
    expect(window.location.search).toBe("");
  });

  it("a refused or expired hand-back is said in words, with a way back", async () => {
    vi.mocked(whatsappClient.complete).mockResolvedValue({
      ok: false,
      status: 400,
      code: "CONNECT_EXPIRED",
      message: "This connection took too long. Try connecting the number again.",
    } as never);
    render(<WhatsAppConnected />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This connection took too long.");
    expect(screen.getByRole("link", { name: "Back to Integrations" })).toHaveAttribute(
      "href",
      "/settings/integrations",
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("opened by hand, with nothing to finish", async () => {
    search = new URLSearchParams();
    render(<WhatsAppConnected />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This page is for coming back from Facebook.");
    expect(whatsappClient.complete).not.toHaveBeenCalled();
  });
});
