import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { filesClient } from "@/lib/files/client";
import { templatesClient, type WhatsAppSubmission } from "@/lib/templates/client";
import { WhatsAppApproval } from "./WhatsAppApproval";

vi.mock("@/lib/templates/client", () => ({
  templatesClient: { whatsapp: vi.fn(), submitToWhatsApp: vi.fn() },
}));
vi.mock("@/lib/files/client", () => ({ filesClient: { list: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const sub = (o: Partial<WhatsAppSubmission>): WhatsAppSubmission => ({
  id: "s1",
  versionId: "v1",
  current: true,
  account: "+91 90000 00001",
  language: "en",
  category: "MARKETING",
  status: "pending",
  reason: null,
  submittedAt: "2026-10-19T06:00:00.000Z",
  decidedAt: null,
  ...o,
});
const GOOD = "Hi {{lead.first_name}}, here is our brochure. Have a look!";
const panel = (o: Partial<Parameters<typeof WhatsAppApproval>[0]> = {}) =>
  render(
    <WhatsAppApproval templateId="t1" body={GOOD} kind="first_touch" dirty={false} readOnly={false} {...o} />,
  );
const region = () => screen.getByRole("region", { name: "WhatsApp approval" });
/** The panel shows once LUME knows where the template stands. */
const ready = () => screen.findByRole("region", { name: "WhatsApp approval" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(templatesClient.whatsapp).mockResolvedValue(ok({ on: true, submissions: [] }));
  vi.mocked(filesClient.list).mockResolvedValue(
    ok({
      files: [
        {
          id: "f1",
          name: "Brochure.pdf",
          kind: "document",
          mime: "application/pdf",
          size: 2048,
          link: { on: false, url: null, opens: 0 },
          createdAt: "2026-10-19T06:00:00.000Z",
          archived: false,
        },
      ],
    }),
  );
});

describe("WhatsApp approval in a template (plan W3b-2 Task 7)", () => {
  it("says what it's for, and where each account stands", async () => {
    vi.mocked(templatesClient.whatsapp).mockResolvedValue(
      ok({ on: true, submissions: [sub({ status: "approved" })] }),
    );
    panel();
    expect(
      await within(await ready()).findByText("Approved", { exact: false, selector: "[data-status]" }),
    ).toHaveTextContent("Approved");
    expect(region()).toHaveTextContent("+91 90000 00001");
    expect(region()).toHaveTextContent("To send it to someone outside WhatsApp's 24 hours");
  });

  it("turned down: WhatsApp's reason, and it can go again once changed", async () => {
    vi.mocked(templatesClient.whatsapp).mockResolvedValue(
      ok({
        on: true,
        submissions: [sub({ status: "rejected", reason: "WhatsApp thinks it belongs in another category." })],
      }),
    );
    panel();
    expect(await within(await ready()).findByText(/Turned down/)).toHaveTextContent(
      "Turned down: WhatsApp thinks it belongs in another category.",
    );
  });

  it("edited since approval: says so, and offers Submit again", async () => {
    vi.mocked(templatesClient.whatsapp).mockResolvedValue(
      ok({ on: true, submissions: [sub({ status: "approved", current: false })] }),
    );
    panel();
    expect(await within(await ready()).findByText("Edited since approval")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit again" })).toBeEnabled();
  });

  it("what WhatsApp would turn down is listed as the words change, and nothing can be submitted", async () => {
    const { rerender } = panel({ body: "Your visit is confirmed, {{lead.first_name}}" });
    expect(
      await within(await ready()).findByText(
        "WhatsApp doesn't take a template that ends with a variable. Add words before and after it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit to WhatsApp" })).toBeDisabled();
    rerender(
      <WhatsAppApproval templateId="t1" body={GOOD} kind="first_touch" dirty={false} readOnly={false} />,
    );
    expect(within(region()).queryByRole("list", { name: "What WhatsApp would turn down" })).toBeNull();
    expect(screen.getByRole("button", { name: "Submit to WhatsApp" })).toBeEnabled();
  });

  it("unsaved words: saved first", async () => {
    panel({ dirty: true });
    expect(await within(await ready()).findByText("Save your changes first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit to WhatsApp" })).toBeDisabled();
  });

  it("submits with the language, the category and a file at the top, then shows it's with WhatsApp", async () => {
    vi.mocked(templatesClient.submitToWhatsApp).mockResolvedValue(
      ok({ on: true, submissions: [sub({})] }) as never,
    );
    panel();
    const user = userEvent.setup();
    await ready();
    expect(screen.getByRole("radio", { name: /Marketing/ })).toHaveAttribute("aria-checked", "true");
    expect(region()).toHaveTextContent("about ₹0.86 + GST each in India");
    await user.click(screen.getByRole("button", { name: "Add a file at the top" }));
    await user.click(await screen.findByRole("option", { name: /Brochure\.pdf/ }));
    expect(region()).toHaveTextContent("Brochure.pdf");
    await user.click(screen.getByRole("button", { name: "Submit to WhatsApp" }));
    expect(templatesClient.submitToWhatsApp).toHaveBeenCalledWith("t1", {
      language: "en",
      category: "MARKETING",
      headerFileId: "f1",
    });
    expect(await within(await ready()).findByText("With WhatsApp for review")).toBeInTheDocument();
  });

  it("a business without WhatsApp set up sees nothing of it", async () => {
    vi.mocked(templatesClient.whatsapp).mockResolvedValue(ok({ on: false, submissions: [] }));
    const { container } = panel();
    await waitFor(() => expect(templatesClient.whatsapp).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("a reminder is a utility message by default", async () => {
    panel({ kind: "reminder" });
    await ready();
    expect(screen.getByRole("radio", { name: /Utility/ })).toHaveAttribute("aria-checked", "true");
  });

  it("someone who can't change templates sees where it stands, and nothing to submit", async () => {
    vi.mocked(templatesClient.whatsapp).mockResolvedValue(
      ok({ on: true, submissions: [sub({ status: "pending" })] }),
    );
    panel({ readOnly: true });
    expect(await within(await ready()).findByText("With WhatsApp for review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Submit/ })).toBeNull();
  });
});
