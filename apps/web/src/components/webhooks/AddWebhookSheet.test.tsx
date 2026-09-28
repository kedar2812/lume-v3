import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftView } from "@/lib/imports/types";
import { webhooksClient } from "@/lib/webhooks/client";
import { AddWebhookSheet } from "./AddWebhookSheet";

vi.mock("@/lib/webhooks/client", () => ({
  webhooksClient: { create: vi.fn(), test: vi.fn(), draft: vi.fn(), save: vi.fn() },
}));
vi.mock("@/lib/imports/client", () => ({ importsClient: { patch: vi.fn(), discard: vi.fn() } }));
// The 2A steps are tested on their own; here they only need to move the wizard along.
vi.mock("@/components/imports/ColumnsStep", () => ({
  ColumnsStep: ({ onContinue }: { onContinue(): void }) => (
    <div>
      <h3>Columns</h3>
      <button onClick={onContinue}>Continue</button>
    </div>
  ),
}));
vi.mock("@/components/imports/RulesStep", () => ({
  RulesStep: ({ onContinue }: { onContinue(): void }) => <button onClick={onContinue}>Continue</button>,
}));
vi.mock("@/components/imports/PreviewStep", () => ({
  PreviewStep: ({ onContinue }: { onContinue?(): void }) => <button onClick={onContinue}>Continue</button>,
}));
const ok = <T,>(data: T, status = 200) => ({ ok: true as const, status, data });
const ADDRESS = "https://crm.example.test/webhooks/in/w1";
const SECRET = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5";
const draft = {
  id: "d1",
  headers: ["name", "contact.phone"],
  headerRow: 1,
  rowCount: 1,
  problems: [],
  mapping: { columns: [{ column: 0, to: "field", field: "name" }], createMissingTags: false },
} as unknown as DraftView;
const run = async (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe("Add a webhook", () => {
  it("where from → the address and secret, once → a test post → the 2A steps → on", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(webhooksClient.create).mockResolvedValue(
      ok(
        {
          source: { id: "w1", name: "Website form" },
          address: ADDRESS,
          secret: SECRET,
          mode: "signed",
        } as never,
        201,
      ),
    );
    vi.mocked(webhooksClient.test)
      .mockResolvedValueOnce(ok(null, 204))
      .mockResolvedValue(
        ok({ paths: ["name", "contact.phone"], unmappable: ["items"], receivedAt: new Date().toISOString() }),
      );
    vi.mocked(webhooksClient.draft).mockResolvedValue(ok(draft, 201));
    vi.mocked(webhooksClient.save).mockResolvedValue(ok({ id: "w1" } as never));
    const onClose = vi.fn();
    render(<AddWebhookSheet open manychat={false} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Add a webhook" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /ManyChat/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Website form/ }));
    await user.click(screen.getByRole("button", { name: "Create webhook" }));
    expect(webhooksClient.create).toHaveBeenCalledWith({ preset: "website", name: "Website form" });

    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    expect(screen.getByText("LUME won't show this again. Copy it now.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy address" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy secret" })).toBeInTheDocument();
    expect(screen.getByLabelText("Code sample")).toHaveTextContent(ADDRESS);
    expect(screen.getByText(/Sign on your server/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Waiting for the first post…")).toBeInTheDocument();
    expect(webhooksClient.test).toHaveBeenCalledTimes(1);
    await run(2100);
    const paths = await screen.findByRole("list", { name: "What the post sent" });
    expect(within(paths).getByText("contact.phone")).toBeInTheDocument();
    expect(screen.getByText(/not a single value/)).toBeInTheDocument();
    expect(webhooksClient.test).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "Use this post" }));
    expect(webhooksClient.draft).toHaveBeenCalledWith("w1");
    expect(await screen.findByRole("heading", { name: "Columns" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" })); // columns
    await user.click(screen.getByRole("button", { name: "Continue" })); // rules
    await user.click(screen.getByRole("button", { name: "Continue" })); // preview
    const keep = screen.getByRole("checkbox", { name: "Keep the test post as a lead" });
    expect(keep).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Turn it on" }));
    expect(webhooksClient.save).toHaveBeenCalledWith("w1", { importId: "d1", keepTest: true });
    expect(onClose).toHaveBeenCalledWith("w1");
  });

  it("final review, Important 7: editing never shows the new-webhook picker, even when the draft fails", async () => {
    vi.mocked(webhooksClient.draft).mockResolvedValue({
      ok: false,
      status: 409,
      code: "NO_TEST_POST",
      message: "LUME couldn't read this webhook's fields.",
    } as never);
    render(<AddWebhookSheet open manychat={false} sourceId="w1" onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Webhook fields" })).toBeInTheDocument();
    expect(screen.queryByText("Where will leads come from?")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't read");
    expect(screen.queryByRole("button", { name: "Create webhook" })).not.toBeInTheDocument();
  });

  it("offers ManyChat only when the server has it switched on", () => {
    render(<AddWebhookSheet open manychat onClose={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /ManyChat/ })).toBeInTheDocument();
  });
});
