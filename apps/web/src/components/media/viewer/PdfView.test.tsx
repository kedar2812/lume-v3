import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPdf, type PdfDoc } from "./pdf";
import { PdfView } from "./PdfView";
import { ToolbarSlot } from "./Toolbar";

vi.mock("./pdf", () => ({ loadPdf: vi.fn() }));

/** A document as pdf.js gives it, with each page's words. */
function doc(pages: string[]): PdfDoc {
  return {
    numPages: pages.length,
    getPage: async (n: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 612 * scale,
        height: 792 * scale,
        convertToViewportRectangle: (r: number[]) => r.map((x) => x * scale),
      }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      getTextContent: async () => ({
        items: [{ str: pages[n - 1]!, transform: [1, 0, 0, 12, 72, 700], width: 200, height: 12 }],
      }),
      cleanup: vi.fn(),
    }),
    destroy: vi.fn(),
  };
}

/** Pages that are in view, as an IntersectionObserver would report them. */
let observed: { cb: IntersectionObserverCallback; els: Element[] }[] = [];
class FakeIO {
  constructor(public cb: IntersectionObserverCallback) {
    observed.push({ cb, els: [] });
  }
  observe(el: Element) {
    observed.at(-1)!.els.push(el);
  }
  unobserve() {}
  disconnect() {}
}
const show = (pageNumbers: number[]) =>
  act(() => {
    for (const o of observed)
      o.cb(
        o.els
          .filter((el) => (el as HTMLElement).dataset.page)
          .map((el) => ({
            target: el,
            isIntersecting: pageNumbers.includes(Number((el as HTMLElement).dataset.page)),
          })) as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
  });

const withToolbar = (ui: React.ReactNode) => {
  const slot = document.createElement("div");
  slot.setAttribute("data-testid", "toolbar");
  document.body.appendChild(slot);
  return render(<ToolbarSlot.Provider value={slot}>{ui}</ToolbarSlot.Provider>);
};

beforeEach(() => {
  observed = [];
  vi.stubGlobal("IntersectionObserver", FakeIO);
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({}) as never);
  document.body.innerHTML = "";
});

describe("a PDF in LUME's viewer (plan 2026-10-20-media-tab, Task 8)", () => {
  it("renders only the pages near the view: at most 3 canvases for a 400-page document", async () => {
    vi.mocked(loadPdf).mockResolvedValue(doc(Array.from({ length: 400 }, (_, i) => `Page ${i + 1}`)));
    withToolbar(<PdfView src="/api/v1/files/f1/content" pages={400} name="Big.pdf" />);
    const pages = await screen.findByRole("region", { name: "Pages of Big.pdf" });
    // One placeholder per page, once the document has loaded.
    expect((await within(pages).findAllByRole("img", { hidden: true })).length).toBe(400);
    show([1]);
    await waitFor(() => expect(document.querySelectorAll("[data-page] canvas").length).toBeGreaterThan(0));
    expect(document.querySelectorAll("[data-page] canvas").length).toBeLessThanOrEqual(3);
    show([200]);
    await waitFor(() => expect(document.querySelector('[data-page="200"] canvas')).not.toBeNull());
    expect(document.querySelector('[data-page="1"] canvas')).toBeNull();
    expect(document.querySelectorAll("[data-page] canvas").length).toBeLessThanOrEqual(3);
  });

  it("says where you are, and its buttons go a page at a time", async () => {
    vi.mocked(loadPdf).mockResolvedValue(doc(["One", "Two", "Three"]));
    withToolbar(<PdfView src="/x" pages={3} name="Brochure.pdf" />);
    const region = await screen.findByRole("region", { name: "Pages of Brochure.pdf" });
    await within(region).findAllByRole("img", { hidden: true });
    // The pages scroll: the keyboard can reach them to scroll too (arrows, Page Down, Space).
    expect(region).toHaveAttribute("tabindex", "0");
    const bar = screen.getByTestId("toolbar");
    expect(bar).toHaveTextContent("Page 1 of 3");
    expect(within(bar).getByRole("button", { name: "Previous page" })).toBeDisabled();
    show([2]);
    await waitFor(() => expect(bar).toHaveTextContent("Page 2 of 3"));
  });

  it("Find in it highlights each match and says which one of how many", async () => {
    vi.mocked(loadPdf).mockResolvedValue(
      doc(["Our prices", "No match here", "Prices for offices", "price list"]),
    );
    withToolbar(<PdfView src="/x" pages={4} name="Brochure.pdf" />);
    await screen.findByRole("region", { name: "Pages of Brochure.pdf" });
    const find = within(screen.getByTestId("toolbar")).getByRole("button", { name: "Find in it" });
    // Its name holds when a phone shows only its icon.
    expect(find).toHaveAttribute("aria-label", "Find in it");
    await userEvent.click(find);
    await userEvent.type(screen.getByRole("searchbox", { name: "Find in Brochure.pdf" }), "price");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 of 3"));
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("2 of 3");
    await userEvent.clear(screen.getByRole("searchbox", { name: "Find in Brochure.pdf" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Find in Brochure.pdf" }), "zebra");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Not in this file"));
    // Escape puts it away, and the focus goes back to its button, never dropped on the page.
    await userEvent.keyboard("{Escape}");
    expect(within(screen.getByTestId("toolbar")).getByRole("button", { name: "Find in it" })).toHaveFocus();
  });

  it("a PDF LUME can't read says so in plain words", async () => {
    vi.mocked(loadPdf).mockRejectedValue(new Error("Invalid PDF structure"));
    withToolbar(<PdfView src="/x" pages={null} name="Broken.pdf" />);
    expect(
      await screen.findByText("LUME couldn't read this PDF. It may be damaged or locked with a password."),
    ).toBeInTheDocument();
  });
});
