import { describe, expect, it, vi } from "vitest";

const destroy = vi.fn(async () => undefined);
const getPage = vi.fn(async (n: number) => ({ n }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  // pdf.js 6: the document has no destroy() of its own; the loading task does.
  getDocument: vi.fn(() => ({ promise: Promise.resolve({ numPages: 3, getPage }), destroy })),
}));

describe("loading a PDF with pdf.js 6", () => {
  it("gives its pages, and letting it go ends the loading task (the worker and its requests)", async () => {
    const { loadPdf } = await import("./pdf");
    const doc = await loadPdf("/api/v1/files/f1/content");
    expect(doc.numPages).toBe(3);
    await doc.getPage(2);
    expect(getPage).toHaveBeenCalledWith(2);
    await doc.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
