// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client";
import { FeedbackReport, type FeedbackDetail } from "./FeedbackReport";
import { FeedbackScreen } from "./FeedbackScreen";

vi.mock("@/lib/client", () => ({
  CHANGED: "lume-licence:changed",
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/feedback",
}));
const clipboard = { writeText: vi.fn(() => Promise.resolve()) };
Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });

const ok = <T,>(data: T) => ({ ok: true as const, data });
/** The API, answered by path; the bell's own look is answered empty. */
function answer(by: Record<string, unknown>) {
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith("/api/alerts")) return ok({ alerts: [] }) as never;
    if (path in by) return ok(by[path]) as never;
    return { ok: false, status: 404, message: "Nothing here." } as never;
  });
}
const detail = (over: Partial<FeedbackDetail> = {}): FeedbackDetail => ({
  id: "f1",
  receivedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  kind: "bug",
  firstLine: "It jumped back.",
  client: { id: "c1", name: "Harbour Clinic" },
  reporter: { name: "Priya Shah", role: "Sales rep", email: "priya@harbour.example" },
  page: "/pipeline",
  status: "seen",
  fixedIn: null,
  imageCount: 2,
  text: "It jumped back.\nTwice.",
  appVersion: "1.4.1",
  browser:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  screen: "1536 × 864 · 1.25×",
  theme: "porcelain",
  note: "",
  closedAt: null,
  imagesRemovedAt: null,
  images: [
    { n: 0, type: "image/webp", width: 1920, height: 1080 },
    { n: 1, type: "image/webp", width: 1920, height: 1080 },
  ],
  latestRelease: "1.4.2",
  clientVersion: "1.4.1",
  ...over,
});

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.patch).mockReset();
  clipboard.writeText.mockClear();
});

describe("the Feedback list", () => {
  it("shows the new tab: bold rows, the words as text, the client, the reporter and the screenshot count", async () => {
    answer({
      "/api/feedback?tab=new": {
        items: [
          {
            id: "f1",
            receivedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
            kind: "bug",
            firstLine: "<b>It jumped back</b>",
            client: { id: "c1", name: "Harbour Clinic" },
            reporter: { name: "Priya Shah", role: "Sales rep" },
            page: "/pipeline",
            status: "new",
            fixedIn: null,
            imageCount: 2,
          },
        ],
        next: null,
        counts: { new: 1, fixing: 0, fixed: 0, all: 1 },
      },
    });
    render(<FeedbackScreen initial={{}} />);
    const row = await screen.findByRole("link", { name: /It jumped back/ });
    expect(row).toHaveAttribute("href", "/feedback/f1");
    expect(row).toHaveClass("fb-new");
    expect(within(row).getByText("<b>It jumped back</b>")).toBeInTheDocument();
    expect(within(row).getByText("Harbour Clinic")).toBeInTheDocument();
    expect(within(row).getByText("Sales rep")).toBeInTheDocument();
    expect(within(row).getByLabelText("2 screenshots")).toBeInTheDocument();
    expect(within(row).getByText("12 min ago")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /New/ })).toHaveAttribute("aria-selected", "true");
  });

  it("starts on All for one client's or one release's reports, and says whose", async () => {
    answer({
      "/api/feedback?tab=all&client=c1": {
        items: [],
        next: null,
        counts: { new: 0, fixing: 0, fixed: 0, all: 0 },
      },
    });
    render(<FeedbackScreen initial={{ client: "c1" }} />);
    expect(
      await screen.findByText("No feedback yet. It arrives here from your clients' LUME."),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /All/ })).toHaveAttribute("aria-selected", "true");
  });
});

describe("one report", () => {
  it("is marked seen when it opens new; Fixed in asks for the release; the note saves after a pause", async () => {
    const user = userEvent.setup();
    answer({ "/api/feedback/f1": detail({ status: "new" }) });
    vi.mocked(api.patch).mockImplementation(async (_p: string, body: unknown) => {
      const b = body as Partial<FeedbackDetail>;
      return ok(detail({ ...b, status: b.status ?? "seen" })) as never;
    });
    render(<FeedbackReport id="f1" />);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/feedback/f1", { status: "seen" }));
    await user.click(await screen.findByRole("button", { name: "Fixed in…" }));
    const v = screen.getByLabelText("Fixed in which release?");
    expect(v).toHaveValue("1.4.2");
    await user.clear(v);
    await user.type(v, "1.4.3");
    await user.click(screen.getByRole("button", { name: "Mark fixed" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/feedback/f1", { status: "fixed", fixedIn: "1.4.3" }),
    );
    expect(await screen.findByRole("button", { name: "Fixed in 1.4.3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.type(screen.getByRole("textbox", { name: "Your note" }), "Drag race");
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith("/api/feedback/f1", { note: "Drag race" }), {
      timeout: 2000,
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("shows the words as text, the email as a mailto, and behind when the client's LUME is older", async () => {
    answer({ "/api/feedback/f1": detail({ text: "<img src=x onerror=alert(1)>" }) });
    render(<FeedbackReport id="f1" />);
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByRole("link", { name: "priya@harbour.example" })).toHaveAttribute(
      "href",
      "mailto:priya@harbour.example",
    );
    expect(screen.getByText("behind")).toBeInTheDocument();
    expect(screen.getByText("Chrome 141 on Windows")).toBeInTheDocument();
  });

  it("copies a bug report, opens a screenshot over the whole window, and closes it with Esc", async () => {
    const user = userEvent.setup();
    answer({ "/api/feedback/f1": detail() });
    render(<FeedbackReport id="f1" />);
    // user-event puts its own clipboard in place: watch that one.
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(await screen.findByRole("button", { name: "Copy as bug report" }));
    expect(write.mock.calls[0]![0]).toMatch(/^## Something's broken: It jumped back\./);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open screenshot 2 of 2" }));
    const viewer = screen.getByRole("dialog", { name: "Screenshot 2 of 2" });
    expect(within(viewer).getByRole("img")).toHaveAttribute("src", "/api/feedback/f1/images/1");
    expect(within(viewer).getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/api/feedback/f1/images/1?download=1",
    );
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("dialog", { name: "Screenshot 1 of 2" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says the screenshots were removed, once they have been", async () => {
    answer({
      "/api/feedback/f1": detail({
        status: "fixed",
        fixedIn: "1.4.0",
        imagesRemovedAt: "2026-10-16T00:00:00.000Z",
        images: [],
      }),
    });
    render(<FeedbackReport id="f1" />);
    expect(await screen.findByText("Screenshots removed 90 days after this was closed.")).toBeInTheDocument();
  });
});
