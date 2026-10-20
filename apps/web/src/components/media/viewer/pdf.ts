"use client";

/** What LUME's PDF view uses of pdf.js: a document, its pages, their size, drawing and words. */
export type PdfViewport = {
  width: number;
  height: number;
  convertToViewportRectangle(rect: number[]): number[];
};
export type PdfTextItem = { str: string; transform: number[]; width: number; height: number };
export type PdfPage = {
  getViewport(o: { scale: number }): PdfViewport;
  render(o: {
    canvas?: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
  }): { promise: Promise<void>; cancel(): void };
  getTextContent(): Promise<{ items: (PdfTextItem | { type: string })[] }>;
  cleanup(): void;
};
export type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): unknown };

let lib: Promise<typeof import("pdfjs-dist")> | null = null;

/**
 * A PDF from LUME's own API, read by pdf.js (Mozilla) in a worker served from LUME itself: nothing goes to another
 * site, and the file's own scripts and XFA forms never run.
 */
export async function loadPdf(src: string): Promise<PdfDoc> {
  lib ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return m;
  });
  const pdfjs = await lib;
  const task = pdfjs.getDocument({
    url: src,
    withCredentials: true,
    enableXfa: false,
    // Pages are fetched as they're needed, in ranges: a 25 MB brochure shows its first page at once.
    disableAutoFetch: true,
    disableStream: false,
  });
  return (await task.promise) as unknown as PdfDoc;
}
