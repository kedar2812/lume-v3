"use client";
import { useState } from "react";
import { AVATAR_COLORS } from "@lume/core/shared";
import s from "./Avatar.module.css";

// Deep enough that white initials reach 4.5:1 on every colour (WCAG AA).
// No violet anywhere (owner, 2026-10-01): a deep rose takes its place.
const PALETTE = Object.values(AVATAR_COLORS);

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Stable colour from the name so the same person always looks the same. */
export function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function Avatar({
  name,
  color,
  photo,
  size = 28,
}: {
  name: string;
  color?: string;
  /** Their photo's address (7C); initials show until it loads, and if it can't. */
  photo?: string;
  size?: number;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const showPhoto = photo && broken !== photo;
  return (
    <span
      role="img"
      aria-label={name}
      className={s.avatar}
      style={{ width: size, height: size, fontSize: size * 0.39, background: color ?? avatarColor(name) }}
    >
      {initials(name)}
      {showPhoto && (
        <img
          className={s.photo}
          src={photo}
          alt=""
          width={size}
          height={size}
          onError={() => setBroken(photo)}
        />
      )}
    </span>
  );
}
