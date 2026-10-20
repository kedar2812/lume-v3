"use client";
import { useState } from "react";
import type { LibraryFile } from "@/lib/files/client";
import { lengthText, mediaMeta } from "@/lib/files/words";
import { FileArt } from "./FileArt";
import s from "./media.module.css";

/** A page of a document is shown as paper on the tile; a photo or a video's frame fills it. */
const isPage = (f: LibraryFile) => f.viewAs !== "image" && f.viewAs !== "video";

/**
 * One file in Media (canvas Main): its content as its picture, its name, and what it is in words. The whole tile
 * opens it. The thumbnail fades in once it has loaded, so a slow one never shows half drawn.
 */
export function MediaTile({ file: f, onOpen }: { file: LibraryFile; onOpen(id: string): void }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const meta = mediaMeta(f);
  const thumb = f.preview === "ready" ? f.thumbUrl : null;
  return (
    <button
      type="button"
      className={s.tile}
      aria-label={`${f.name}, ${meta}${f.link.on ? ", shared by link" : ""}`}
      data-viewer-origin={f.id}
      onClick={() => onOpen(f.id)}
    >
      <span className={s.thumb} data-kind={f.viewAs} data-page={isPage(f) || undefined}>
        {thumb ? (
          <img
            key={thumb}
            src={thumb}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className={isPage(f) ? s.pageImg : s.fillImg}
            data-loaded={loaded === thumb || undefined}
            onLoad={() => setLoaded(thumb)}
          />
        ) : (
          <FileArt file={f} />
        )}
        {f.preview === "pending" && <span className={s.waiting}>Preview on its way</span>}
        {f.viewAs === "video" && (
          <span className={s.play} aria-hidden>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5.5v13l11-6.5z" />
            </svg>
          </span>
        )}
        {f.durationMs !== null && (f.viewAs === "video" || f.viewAs === "audio") && (
          <span className={s.length} aria-hidden>
            {lengthText(f.durationMs)}
          </span>
        )}
        {f.link.on && (
          <span className={s.badge} aria-hidden>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
            >
              <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
              <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
            </svg>
            Link on
          </span>
        )}
      </span>
      <span className={s.cap}>
        <span className={s.name}>{f.name}</span>
        <span className={s.meta}>{meta}</span>
      </span>
    </button>
  );
}
