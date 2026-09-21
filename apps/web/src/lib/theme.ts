export type ThemePref = "system" | "porcelain" | "obsidian";
export const THEME_COOKIE = "lume_theme";
const PREFS: readonly ThemePref[] = ["system", "porcelain", "obsidian"];

export function parseThemePref(v: string | undefined): ThemePref {
  return PREFS.includes(v as ThemePref) ? (v as ThemePref) : "system";
}

/** Phase 1 also stores this on the user profile; the cookie lets the server render without a flash. */
export function themeCookie(pref: ThemePref): string {
  return `${THEME_COOKIE}=${pref}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
