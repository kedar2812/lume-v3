import type { LibraryFile } from "./client";

/** Tests only: a library file's Media fields when nothing about its preview matters to the test. */
export const NO_PREVIEW: Pick<
  LibraryFile,
  "viewAs" | "preview" | "thumbUrl" | "pages" | "durationMs" | "width" | "height"
> = {
  viewAs: "pdf",
  preview: "none",
  thumbUrl: null,
  pages: null,
  durationMs: null,
  width: null,
  height: null,
};
