import { bytesText } from "@lume/core/shared";
import type { LibraryFile } from "./client";

const TYPE_WORD: Record<string, string> = {
  "application/pdf": "PDF",
  "text/plain": "Text",
  "image/jpeg": "Photo",
  "image/png": "Photo",
};

/** What a file is, in a word: "PDF", "Photo", "DOCX" (from its name), "Video", or "File". */
export const fileTypeWord = (f: { mime: string; kind: string; name: string | null }) =>
  TYPE_WORD[f.mime] ?? f.name?.split(".").pop()?.toUpperCase() ?? (f.kind === "video" ? "Video" : "File");

const POWERPOINT = new Set([
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/** What a file in Media is, as a person says it: Photo, Video, Audio, PDF, Word, PowerPoint, Excel, Text. */
export function mediaWord(f: Pick<LibraryFile, "viewAs" | "mime">): string {
  switch (f.viewAs) {
    case "image":
      return "Photo";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "pdf":
      return "PDF";
    case "office":
      return POWERPOINT.has(f.mime) ? "PowerPoint" : "Word";
    case "sheet":
      return "Excel";
    case "text":
      return "Text";
  }
}

/** The short name on a file's own art when there's no picture of it: its extension, at most four letters. */
export const extensionWord = (name: string) => {
  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase().slice(0, 4) : "";
  return ext || "FILE";
};

/** A length as a clock: 0:05, 1:05, 1:02:05. */
export function lengthText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A tile's line: what it is, then its pages or length when known, then its size. */
export function mediaMeta(f: Pick<LibraryFile, "viewAs" | "mime" | "pages" | "durationMs" | "size">): string {
  const parts = [mediaWord(f)];
  if (f.pages && (f.viewAs === "pdf" || f.viewAs === "office")) {
    const unit = POWERPOINT.has(f.mime) ? "slide" : "page";
    parts.push(`${f.pages} ${unit}${f.pages === 1 ? "" : "s"}`);
  }
  if (f.durationMs && (f.viewAs === "video" || f.viewAs === "audio")) parts.push(lengthText(f.durationMs));
  parts.push(bytesText(f.size));
  return parts.join(" · ");
}
