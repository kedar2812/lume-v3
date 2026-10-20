"use client";
import type { Sheet } from "./sheet";

/** How long a workbook may take to read before LUME gives up on it. */
const READ_MS = 30_000;

/** A spreadsheet from LUME's own API, read in a worker (sheet.worker.ts). */
export async function loadSheets(src: string): Promise<Sheet[]> {
  const r = await fetch(src, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`couldn't fetch (${r.status})`);
  const buf = await r.arrayBuffer();
  if (typeof Worker === "undefined") return (await import("./sheet")).readSheets(buf);
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./sheet.worker.ts", import.meta.url), { type: "module" });
    const t = setTimeout(() => {
      w.terminate();
      reject(new Error("took too long"));
    }, READ_MS);
    w.onmessage = (e: MessageEvent<{ ok: true; sheets: Sheet[] } | { ok: false; error: string }>) => {
      clearTimeout(t);
      w.terminate();
      if (e.data.ok) resolve(e.data.sheets);
      else reject(new Error(e.data.error));
    };
    w.onerror = (e) => {
      clearTimeout(t);
      w.terminate();
      reject(new Error(e.message || "the reader stopped"));
    };
    w.postMessage(buf, [buf]);
  });
}
