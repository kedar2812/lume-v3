import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webhooksClient } from "@/lib/webhooks/client";
import type { WebhookView } from "@/lib/webhooks/types";
import { WebhooksCard } from "./WebhooksCard";

vi.mock("@/lib/webhooks/client", () => ({ webhooksClient: { setEnabled: vi.fn(), list: vi.fn() } }));
vi.mock("@/components/webhooks/AddWebhookSheet", () => ({
  AddWebhookSheet: ({ open, manychat }: { open: boolean; manychat: boolean }) =>
    open ? <div role="dialog" aria-label="Add a webhook" data-manychat={String(manychat)} /> : null,
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const hook = (over: Partial<WebhookView> = {}): WebhookView => ({
  id: "w1",
  name: "Landing page",
  status: "active",
  attention: null,
  preset: "website",
  mode: "signed",
  address: "https://crm.example.test/webhooks/in/w1",
  lastEventAt: new Date(Date.now() - 180_000).toISOString(),
  eventsToday: 12,
  eventsAllTime: 340,
  created: 300,
  merged: 40,
  problems: 1,
  rejected: 0,
  lastRejectedReason: null,
  newColumns: [],
  runAs: { id: "u1", name: "Riya Sharma" },
  ...over,
});
const view = (enabled: boolean, manychat = false) => ({
  googleSheets: { enabled: false, available: false, email: null, connectWithGoogle: false },
  webhooks: { enabled, manychat },
});

beforeEach(() => vi.clearAllMocks());

describe("the Webhooks card", () => {
  it("is off by default: one switch, and nothing else", async () => {
    const onView = vi.fn();
    vi.mocked(webhooksClient.setEnabled).mockResolvedValue(ok(view(true)));
    render(<WebhooksCard webhooks={{ enabled: false, manychat: false }} onView={onView} />);
    expect(screen.queryByRole("button", { name: "Add a webhook" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Webhooks" }));
    expect(webhooksClient.setEnabled).toHaveBeenCalledWith(true);
    expect(onView).toHaveBeenCalledWith(view(true));
  });

  it("on: each webhook says how it's doing, and Add opens the setup", async () => {
    vi.mocked(webhooksClient.list).mockResolvedValue(
      ok({ sources: [hook(), hook({ id: "w2", name: "Half set up", status: "draft", lastEventAt: null })] }),
    );
    render(<WebhooksCard webhooks={{ enabled: true, manychat: false }} onView={vi.fn()} />);
    const link = await screen.findByRole("link", { name: /Landing page/ });
    expect(link).toHaveAttribute("href", "/settings/integrations/webhooks/w1");
    expect(link).toHaveTextContent("Last post 3 min ago · 12 today · 1 problem");
    expect(screen.getByRole("link", { name: /Half set up/ })).toHaveTextContent("Setting up");
    await userEvent.click(screen.getByRole("button", { name: "Add a webhook" }));
    expect(screen.getByRole("dialog", { name: "Add a webhook" })).toHaveAttribute("data-manychat", "false");
  });

  it("offers ManyChat only when this server has it switched on", async () => {
    vi.mocked(webhooksClient.list).mockResolvedValue(ok({ sources: [] }));
    render(<WebhooksCard webhooks={{ enabled: true, manychat: true }} onView={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Add a webhook" }));
    expect(screen.getByRole("dialog", { name: "Add a webhook" })).toHaveAttribute("data-manychat", "true");
  });
});
