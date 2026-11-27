"use client";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import { useEffect, useRef, useState } from "react";
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
  const img = useRef<HTMLImageElement>(null);
  // A thumbnail the browser had already (it loaded before the page came alive, so its load went unheard).
  useEffect(() => {
    if (thumb && img.current?.complete && img.current.naturalWidth > 0) setLoaded(thumb);
  }, [thumb]);
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
            ref={img}
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
            <UI_ICONS.play size={ICON_SIZE.md} aria-hidden />
          </span>
        )}
        {f.durationMs !== null && (f.viewAs === "video" || f.viewAs === "audio") && (
          <span className={s.length} aria-hidden>
            {lengthText(f.durationMs)}
          </span>
        )}
        {f.link.on && (
          <span className={s.badge} aria-hidden>
            <UI_ICONS.link size={ICON_SIZE.md} aria-hidden />
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
