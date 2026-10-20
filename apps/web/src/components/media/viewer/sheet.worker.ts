/// <reference lib="webworker" />
import { readSheets } from "./sheet";

/** Reads a workbook off the page's thread, so a big one never freezes LUME while it's read. */
self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  try {
    self.postMessage({ ok: true, sheets: readSheets(e.data) });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
  }
};
