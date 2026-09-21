import s from "./Avatar.module.css";

// Deep enough that white initials reach 4.5:1 on every colour (WCAG AA).
const PALETTE = ["#C62A30", "#A15C00", "#2A5BFF", "#0F7F44", "#5B43C8", "#0B7285"];

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

export function Avatar({ name, color, size = 28 }: { name: string; color?: string; size?: number }) {
  return (
    <span
      role="img"
      aria-label={name}
      className={s.avatar}
      style={{ width: size, height: size, fontSize: size * 0.39, background: color ?? avatarColor(name) }}
    >
      {initials(name)}
    </span>
  );
}
