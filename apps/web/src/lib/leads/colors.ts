/** Stage, tag and option colours are token names in the API; these are the matching CSS variables. */
const COLOR: Record<string, string> = {
  accent: "var(--accent)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  danger: "var(--danger)",
  meet: "var(--meet)",
  cyan: "var(--cyan)",
  neutral: "var(--text-3)",
};

export const tokenColor = (name: string | null | undefined): string => COLOR[name ?? ""] ?? COLOR.neutral!;
