import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackSheet } from "./FeedbackSheet";

const post = vi.fn();
const toast = vi.fn();
vi.mock("@/lib/feedback/client", () => ({ feedbackClient: { send: (b: unknown) => post(b) } }));
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/leads" }));
let encoded = 0;
const shot = (data = "UklGRg==") => ({
  type: "image/webp" as const,
  data,
  url: `blob:shot-${++encoded}`,
  width: 1600,
  height: 900,
  bytes: 6,
});
const encode = vi.fn();
vi.mock("@/lib/feedback/encode", () => ({
  canCapture: () => false,
  loadImage: async () => ({ width: 1600, height: 900, close() {} }),
  encodeShot: (...a: unknown[]) => encode(...a),
  captureTab: async () => null,
}));

// jsdom has no object URLs; the thumbnails are let go all the same.
URL.revokeObjectURL = vi.fn();
const open = (onClose = vi.fn()) => render(<FeedbackSheet open onClose={onClose} />);
const png = (i = 0) => new File([new Uint8Array([i])], `${i}.png`, { type: "image/png" });
beforeEach(() => {
  post.mockReset();
  toast.mockReset();
  encode.mockReset();
  encode.mockImplementation(async () => shot());
});
/** An encode that finishes when the test says so. */
function held() {
  let done!: (v: ReturnType<typeof shot>) => void;
  encode.mockImplementationOnce(() => new Promise((r) => (done = r)));
  return (data: string) => done(shot(data));
}

describe("Send feedback", () => {
  it("opens on Something's broken, with the plain line, and Send waits for words", () => {
    open();
    expect(screen.getByRole("dialog", { name: "Send feedback" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Something's broken" })).toBeChecked();
    expect(
      screen.getByText(/This goes to the team that makes LUME, with your name, email and role/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByText("Tell LUME what happened")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Capture this screen" })).toBeNull(); // this browser can't
  });

  it("sends the kind, the words, the page without its search, the theme, the screen and the screenshots — once", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    post.mockImplementation(
      () => new Promise((r) => (release = () => r({ ok: true, status: 200, data: { ok: true } }))),
    );
    const onClose = vi.fn();
    open(onClose);
    await user.click(screen.getByRole("radio", { name: "An idea" }));
    await user.type(screen.getByLabelText("What happened?"), "Snooze by an hour, please");
    await user.upload(screen.getByLabelText("Choose images"), png());
    await screen.findByRole("img", { name: "Screenshot 1" });
    await user.dblClick(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    release();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toMatchObject({
      kind: "idea",
      text: "Snooze by an hour, please",
      page: "/leads",
      theme: "porcelain",
      images: [{ type: "image/webp", data: "UklGRg==" }],
    });
    expect(post.mock.calls[0]![0].screen).toMatch(/^\d+ × \d+ · [\d.]+×$/);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Sent — thank you." }));
    expect(toast.mock.calls[0]![0].sound).toBeUndefined(); // sending isn't an achievement
  });

  it("keeps everything when it doesn't go, says why, and Send becomes Try again", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ ok: false, status: 503, code: "FEEDBACK_UNREACHABLE", message: "" });
    const onClose = vi.fn();
    open(onClose);
    await user.type(screen.getByLabelText("What happened?"), "The calendar is off by 30 minutes");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "LUME couldn't reach its team just now. Your report is still here — try again in a minute.",
    );
    expect(screen.getByLabelText("What happened?")).toHaveValue("The calendar is off by 30 minutes");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("marks the screenshot LUME couldn't send, and keeps the others", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({
      ok: false,
      status: 422,
      code: "FEEDBACK_IMAGE_REFUSED",
      message: "",
      details: { index: 1 },
    });
    open();
    await user.type(screen.getByLabelText("What happened?"), "Two shots");
    await user.upload(screen.getByLabelText("Choose images"), [png(1), png(2)]);
    await screen.findByRole("img", { name: "Screenshot 2" });
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("LUME can't send this one — choose it again")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /Screenshot \d/ })).toHaveLength(2);
  });

  it("asks before throwing a report away, and closes at once when there's nothing in it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    open(onClose);
    await user.type(screen.getByLabelText("What happened?"), "half a thought");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Discard this report?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep writing" }));
    expect(screen.getByLabelText("What happened?")).toHaveValue("half a thought");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const empty = vi.fn();
    open(empty);
    await user.click(screen.getAllByRole("button", { name: "Cancel" }).at(-1)!);
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it("takes five screenshots and no more", async () => {
    const user = userEvent.setup();
    open();
    await user.upload(screen.getByLabelText("Choose images"), [0, 1, 2, 3, 4, 5].map(png));
    await waitFor(() => expect(screen.getAllByRole("img", { name: /Screenshot \d/ })).toHaveLength(5));
    expect(screen.getByLabelText("Choose images")).toBeDisabled();
    expect(screen.getByText("5 of 5")).toBeInTheDocument();
  });

  it("never sends a screenshot before its blur is burned in: Send waits, and the blurred one goes", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    open();
    await user.type(screen.getByLabelText("What happened?"), "A lead's number shows in the wrong field");
    await user.upload(screen.getByLabelText("Choose images"), png());
    await screen.findByRole("img", { name: "Screenshot 1" });
    const finish = held();
    await user.click(screen.getByRole("button", { name: "Blur screenshot 1" }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    // Burning in: nothing can go, and the blur can't be reopened on the old picture.
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Blur screenshot 1" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(post).not.toHaveBeenCalled();
    finish("QkxVUlJFRA==");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0].images).toEqual([{ type: "image/webp", data: "QkxVUlJFRA==" }]);
  });

  it("holds Send while a screenshot is still being made ready, then sends it", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    open();
    await user.type(screen.getByLabelText("What happened?"), "Pasted and sent at once");
    const finish = held();
    await user.upload(screen.getByLabelText("Choose images"), png());
    expect(await screen.findByText("1 of 5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    finish("UkVBRFk=");
    await screen.findByRole("img", { name: "Screenshot 1" });
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0].images).toEqual([{ type: "image/webp", data: "UkVBRFk=" }]);
  });
});
