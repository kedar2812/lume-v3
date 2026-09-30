import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webhooksClient } from "@/lib/webhooks/client";
import type { WebhookDetail as Detail } from "@/lib/webhooks/types";
import { WebhookDetail } from "./WebhookDetail";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/webhooks/client", () => ({
  webhooksClient: {
    get: vi.fn(),
    patch: vi.fn(),
    rotate: vi.fn(),
    retry: vi.fn(),
    dismiss: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock("@/components/webhooks/AddWebhookSheet", () => ({
  AddWebhookSheet: ({ open, sourceId }: { open: boolean; sourceId?: string }) =>
    open ? <div role="dialog" aria-label="Webhook fields" data-source={sourceId} /> : null,
}));
const ok = <T,>(data: T, status = 200) => ({ ok: true as const, status, data });
const detail = (over: Partial<Detail> = {}): Detail => ({
  id: "w1",
  name: "Landing page",
  status: "active",
  attention: null,
  preset: "website",
  mode: "signed",
  address: "https://crm.example.test/webhooks/in/w1",
  lastEventAt: new Date(Date.now() - 60_000).toISOString(),
  eventsToday: 4,
  eventsAllTime: 120,
  created: 100,
  merged: 15,
  problems: 1,
  rejected: 3,
  lastRejectedReason: "bad_signature",
  newColumns: [],
  runAs: { id: "u1", name: "Riya Sharma" },
  events: [
    { id: 9, receivedAt: new Date().toISOString(), status: "done", result: "created", leadId: "l9" },
    { id: 8, receivedAt: new Date().toISOString(), status: "error", result: null, leadId: null },
  ],
  problemEvents: [
    {
      id: 8,
      receivedAt: new Date().toISOString(),
      problems: [{ code: "CELL_TOO_LONG", message: "A value is over 10,000 characters." }],
    },
  ],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("a webhook's page", () => {
  it("shows its health, what posts did, problems, and what was refused, in words", async () => {
    vi.mocked(webhooksClient.get).mockResolvedValue(ok(detail()));
    render(<WebhookDetail id="w1" />);
    expect(await screen.findByRole("heading", { name: "Landing page" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Integrations" })).toHaveAttribute(
      "href",
      "/settings/integrations",
    );
    expect(screen.getByText("https://crm.example.test/webhooks/in/w1")).toBeInTheDocument();
    expect(screen.getByText(/3 refused · last for a bad signature/)).toBeInTheDocument();
    const events = screen.getByRole("table", { name: "Recent posts" });
    expect(within(events).getByRole("link", { name: "New lead" })).toHaveAttribute("href", "/leads?lead=l9");
    expect(screen.getByText("A value is over 10,000 characters.")).toBeInTheDocument();
  });

  it("retries and dismisses a problem post", async () => {
    vi.mocked(webhooksClient.get).mockResolvedValue(ok(detail()));
    vi.mocked(webhooksClient.retry).mockResolvedValue(ok({ queued: true }, 202) as never);
    vi.mocked(webhooksClient.dismiss).mockResolvedValue(ok(null, 204));
    render(<WebhookDetail id="w1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Retry post 8" }));
    expect(webhooksClient.retry).toHaveBeenCalledWith("w1", 8);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss post 8" }));
    expect(webhooksClient.dismiss).toHaveBeenCalledWith("w1", 8);
  });

  it("a new secret is asked for first, then shown once", async () => {
    vi.mocked(webhooksClient.get).mockResolvedValue(ok(detail()));
    vi.mocked(webhooksClient.rotate).mockResolvedValue(
      ok({ secret: "bmV3LXNlY3JldC1uZXctc2VjcmV0LW5ldy1zZWNyZXQ" }),
    );
    render(<WebhookDetail id="w1" />);
    await userEvent.click(await screen.findByRole("button", { name: "New secret" }));
    const ask = screen.getByRole("dialog", { name: "Give it a new secret?" });
    expect(ask).toHaveTextContent("The old secret stops working at once");
    expect(webhooksClient.rotate).not.toHaveBeenCalled();
    await userEvent.click(within(ask).getByRole("button", { name: "New secret" }));
    expect(await screen.findByText("bmV3LXNlY3JldC1uZXctc2VjcmV0LW5ldy1zZWNyZXQ")).toBeInTheDocument();
    expect(screen.getByText("LUME won't show this again. Copy it now.")).toBeInTheDocument();
  });

  it("pause, edit fields, and remove only after saying the leads stay", async () => {
    vi.mocked(webhooksClient.get).mockResolvedValue(ok(detail()));
    vi.mocked(webhooksClient.patch).mockResolvedValue(ok(detail({ status: "paused" })));
    vi.mocked(webhooksClient.remove).mockResolvedValue(ok(null, 204));
    render(<WebhookDetail id="w1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(webhooksClient.patch).toHaveBeenCalledWith("w1", { paused: true });
    await userEvent.click(screen.getByRole("button", { name: "Edit fields and rules" }));
    expect(screen.getByRole("dialog", { name: "Webhook fields" })).toHaveAttribute("data-source", "w1");
    await userEvent.click(screen.getByRole("button", { name: "Remove webhook" }));
    const ask = screen.getByRole("dialog", { name: "Remove this webhook?" });
    expect(ask).toHaveTextContent("Its leads stay in LUME");
    await userEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    expect(webhooksClient.remove).toHaveBeenCalledWith("w1");
    expect(push).toHaveBeenCalledWith("/settings/integrations");
  });

  it("one being set up offers to finish it", async () => {
    vi.mocked(webhooksClient.get).mockResolvedValue(
      ok(detail({ status: "draft", events: [], problemEvents: [] })),
    );
    render(<WebhookDetail id="w1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Finish setting up" }));
    expect(screen.getByRole("dialog", { name: "Webhook fields" })).toBeInTheDocument();
  });

  it("needs attention: it can still be paused", async () => {
    vi.mocked(webhooksClient.get).mockResolvedValue(
      ok(
        detail({
          status: "needs_attention",
          attention: { code: "COLUMNS_CHANGED", message: "A field changed." },
        }),
      ),
    );
    render(<WebhookDetail id="w1" />);
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("Retry and Dismiss wait while one is going, so a double click can't say it's gone", async () => {
    vi.mocked(webhooksClient.get).mockResolvedValue(ok(detail()));
    let finish!: (v: unknown) => void;
    vi.mocked(webhooksClient.retry).mockReturnValue(new Promise((r) => (finish = r)) as never);
    render(<WebhookDetail id="w1" />);
    const retry = await screen.findByRole("button", { name: /^Retry post/ });
    await userEvent.click(retry);
    expect(screen.getByRole("button", { name: /^Retry post/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Dismiss post/ })).toBeDisabled();
    finish(ok(null));
  });

  it("a new secret or a removal that fails says so inside its dialog", async () => {
    vi.mocked(webhooksClient.get).mockResolvedValue(ok(detail()));
    const failed = {
      ok: false,
      status: 0,
      code: "OFFLINE",
      message: "LUME can’t reach the server right now.",
    };
    vi.mocked(webhooksClient.rotate).mockResolvedValue(failed as never);
    vi.mocked(webhooksClient.remove).mockResolvedValue(failed as never);
    render(<WebhookDetail id="w1" />);
    await userEvent.click(await screen.findByRole("button", { name: "New secret" }));
    const rot = screen.getByRole("dialog", { name: "Give it a new secret?" });
    await userEvent.click(within(rot).getByRole("button", { name: "New secret" }));
    expect(await within(rot).findByRole("alert")).toHaveTextContent("can’t reach the server");
    await userEvent.click(within(rot).getByRole("button", { name: "Keep the old one" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove webhook" }));
    const rm = screen.getByRole("dialog", { name: "Remove this webhook?" });
    await userEvent.click(within(rm).getByRole("button", { name: "Remove" }));
    expect(await within(rm).findByRole("alert")).toHaveTextContent("can’t reach the server");
  });
});
