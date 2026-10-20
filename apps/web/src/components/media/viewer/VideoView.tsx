"use client";
import { Maximize, Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { contentUrl, type LibraryFile } from "@/lib/files/client";
import { lengthText } from "@/lib/files/words";
import { Scrubber, useMediaElement } from "./Scrubber";
import v from "./viewer.module.css";

/** How long the controls stay after the pointer stops, while it plays. */
const IDLE_MS = 2500;

const PLAY_PROPS = { size: 20, fill: "currentColor", strokeWidth: 0, "aria-hidden": true } as const;
const LINE_PROPS = { size: 20, strokeWidth: 1.9, "aria-hidden": true } as const;

/**
 * A video, played inside LUME (canvas Video): the browser's own player with LUME's controls over it, inline on a
 * phone (never full screen by itself). Space plays and pauses; the controls step aside while it plays untouched.
 */
export function VideoView({ file: f }: { file: LibraryFile }) {
  const m = useMediaElement(f.durationMs);
  const box = useRef<HTMLDivElement>(null);
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = () => {
    setIdle(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setIdle(true), IDLE_MS);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const aspect = f.width && f.height ? `${f.width} / ${f.height}` : "16 / 9";
  return (
    <div
      ref={box}
      className={v.video}
      style={{ aspectRatio: aspect }}
      data-idle={(m.playing && idle) || undefined}
      onPointerMove={wake}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "k") && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          m.toggle();
        }
      }}
    >
      <video
        ref={m.ref}
        src={contentUrl(f.id)}
        poster={f.thumbUrl ?? undefined}
        playsInline
        preload="metadata"
        onClick={m.toggle}
      />
      {!m.playing && (
        <button type="button" className={v.bigPlay} aria-label="Play" onClick={m.toggle}>
          <Play {...PLAY_PROPS} />
        </button>
      )}
      <div className={v.controls}>
        <Scrubber time={m.time} duration={m.duration} onSeek={m.seek} />
        <div className={v.controlRow}>
          {m.playing && (
            <button type="button" className={v.ctl} aria-label="Pause" onClick={m.toggle}>
              <Pause {...PLAY_PROPS} />
            </button>
          )}
          <button type="button" className={v.ctl} aria-label="Back 10 seconds" onClick={() => m.seek(m.time - 10)}>
            <RotateCcw {...LINE_PROPS} />
          </button>
          <span className={v.time}>
            {lengthText(m.time * 1000)} / {lengthText(m.duration * 1000)}
          </span>
          <span className={v.grow} />
          <button type="button" className={v.ctl} aria-label={m.muted ? "Sound on" : "Sound off"} onClick={m.mute}>
            {m.muted ? <VolumeX {...LINE_PROPS} /> : <Volume2 {...LINE_PROPS} />}
          </button>
          <button
            type="button"
            className={v.ctl}
            aria-label="Full screen"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void box.current?.requestFullscreen?.();
            }}
          >
            <Maximize {...LINE_PROPS} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** A voice note or sound (Media): a calm card with its own play button and track. */
export function AudioView({ file: f }: { file: LibraryFile }) {
  const m = useMediaElement(f.durationMs);
  return (
    <div className={v.audio}>
      <audio ref={m.ref} src={contentUrl(f.id)} preload="metadata" />
      <button type="button" className={v.audioPlay} aria-label={m.playing ? "Pause" : "Play"} onClick={m.toggle}>
        {m.playing ? <Pause {...PLAY_PROPS} /> : <Play {...PLAY_PROPS} />}
      </button>
      <div className={v.bars} data-playing={m.playing || undefined} aria-hidden>
        {Array.from({ length: 28 }, (_, i) => (
          <i key={i} style={{ height: `${30 + Math.round(Math.abs(Math.sin(i * 1.7)) * 70)}%` }} />
        ))}
      </div>
      <div className={v.audioTrack}>
        <Scrubber time={m.time} duration={m.duration} onSeek={m.seek} />
        <span className={v.time}>
          {lengthText(m.time * 1000)} / {lengthText(m.duration * 1000)}
        </span>
      </div>
    </div>
  );
}
