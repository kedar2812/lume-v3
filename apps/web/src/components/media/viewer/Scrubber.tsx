"use client";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { lengthText } from "@/lib/files/words";
import v from "./viewer.module.css";
import { capturePointer } from "@/lib/pointer";

/** A video's or a sound's state, read from its element as it plays. */
export function useMediaElement(known: number | null) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(known ? known / 1000 : 0);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => setPlaying(true);
    const off = () => setPlaying(false);
    const tick = () => setTime(el.currentTime);
    const meta = () => Number.isFinite(el.duration) && el.duration > 0 && setDuration(el.duration);
    const vol = () => setMuted(el.muted);
    el.addEventListener("play", on);
    el.addEventListener("pause", off);
    el.addEventListener("ended", off);
    el.addEventListener("timeupdate", tick);
    el.addEventListener("loadedmetadata", meta);
    el.addEventListener("durationchange", meta);
    el.addEventListener("volumechange", vol);
    return () => {
      el.removeEventListener("play", on);
      el.removeEventListener("pause", off);
      el.removeEventListener("ended", off);
      el.removeEventListener("timeupdate", tick);
      el.removeEventListener("loadedmetadata", meta);
      el.removeEventListener("durationchange", meta);
      el.removeEventListener("volumechange", vol);
    };
  }, []);
  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) void el.play()?.catch?.(() => undefined);
    else el.pause();
  }, []);
  const seek = useCallback(
    (to: number) => {
      const el = ref.current;
      if (!el) return;
      const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration;
      el.currentTime = Math.max(0, Math.min(d || 0, to));
      setTime(el.currentTime);
    },
    [duration],
  );
  const mute = useCallback(() => {
    const el = ref.current;
    if (el) el.muted = !el.muted;
  }, []);
  return { ref, playing, time, duration, muted, toggle, seek, mute };
}

/**
 * Where a video or sound is (canvas Video): a track that follows the pointer 1:1 while it's dragged, and the keyboard
 * moves it 5 seconds a press. Its arrows never move to another file.
 */
export function Scrubber({
  time,
  duration,
  onSeek,
}: {
  time: number;
  duration: number;
  onSeek(to: number): void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? time;
  const share = duration > 0 ? Math.min(1, shown / duration) : 0;
  const at = (e: PointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration : 0;
  };
  const keys = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[e.key];
    if (step !== undefined) onSeek(time + step);
    else if (e.key === "Home") onSeek(0);
    else if (e.key === "End") onSeek(duration);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div
      ref={track}
      className={v.scrub}
      role="slider"
      tabIndex={0}
      aria-label="Position"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={`${lengthText(shown * 1000)} of ${lengthText(duration * 1000)}`}
      data-dragging={drag !== null || undefined}
      onKeyDown={keys}
      onPointerDown={(e) => {
        e.stopPropagation();
        capturePointer(e.currentTarget, e.pointerId);
        setDrag(at(e));
      }}
      onPointerMove={(e) => drag !== null && setDrag(at(e))}
      onPointerUp={(e) => {
        if (drag === null) return;
        onSeek(at(e));
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      <span className={v.scrubFill} style={{ transform: `scaleX(${share})` }} />
      <span className={v.scrubKnob} style={{ left: `${share * 100}%` }} />
    </div>
  );
}
