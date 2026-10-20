import type { LibraryFile } from "@/lib/files/client";
import { extensionWord, mediaWord } from "@/lib/files/words";
import s from "./media.module.css";

/**
 * Each kind's own ink on its paper, so a Word file and a PDF tell apart at a glance before their thumbnails arrive.
 * Fixed, not the theme's: the paper is white in Obsidian too, and the inks must read on it.
 */
const INK: Record<string, string> = {
  PDF: "#c3272d",
  Word: "#1e47d9",
  PowerPoint: "#8a5a00",
  Excel: "#0c7845",
  Text: "#5a606d",
};

/**
 * A file shown by its kind when there's no picture of it: a sheet of paper with its extension for documents, the
 * kind's glyph for photos, videos and sound. Never a broken image.
 */
export function FileArt({
  file,
  size = "tile",
}: {
  file: Pick<LibraryFile, "viewAs" | "mime" | "name">;
  size?: "tile" | "small";
}) {
  const word = mediaWord(file);
  if (file.viewAs === "image" || file.viewAs === "video" || file.viewAs === "audio")
    return (
      <span className={s.glyph} data-size={size} aria-hidden>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {file.viewAs === "image" && (
            <>
              <rect x="3" y="3" width="18" height="18" rx="4" />
              <circle cx="9" cy="9" r="1.8" />
              <path d="m21 15-4.5-4.5L7 20" />
            </>
          )}
          {file.viewAs === "video" && (
            <>
              <rect x="2.5" y="5" width="14" height="14" rx="3" />
              <path d="m16.5 10 5-3v10l-5-3" />
            </>
          )}
          {file.viewAs === "audio" && <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />}
        </svg>
      </span>
    );
  return (
    <span
      className={s.paper}
      data-size={size}
      aria-hidden
      style={{ ["--ink" as string]: INK[word] ?? "#5a606d" }}
    >
      <b>{extensionWord(file.name)}</b>
      <i />
      <i />
      <i />
    </span>
  );
}
