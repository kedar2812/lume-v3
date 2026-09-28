import { fold, suggestMapping, type ColumnMap, type IntakeField, type Mapping } from "@lume/core";

export type Preset = "website" | "zapier" | "make" | "manychat";
export type PresetInfo = {
  label: string;
  /** An official mark from /brand, or null (the web shows the preset's name only). */
  mark: string | null;
  /** "signed": the sender signs each post; "token": it can only send a secret header (2C spec §4). */
  mode: "signed" | "token";
  /** A JSON path → a field key, or "name_part:first" / "name_part:last". */
  paths: Record<string, string>;
  /** Not offered until verified against the real service. */
  hidden?: boolean;
};

const CONTACT = { name: "name", phone: "phone", email: "email", instagram: "instagram" };

/** 2C spec §5. Zapier's and Make's official marks aren't in /brand yet, so they show by name. */
export const PRESETS: Record<Preset, PresetInfo> = {
  website: { label: "Website form", mark: null, mode: "signed", paths: CONTACT },
  zapier: { label: "Zapier", mark: null, mode: "signed", paths: CONTACT },
  make: { label: "Make", mark: null, mode: "signed", paths: CONTACT },
  manychat: {
    label: "ManyChat",
    mark: null,
    mode: "token",
    hidden: true,
    paths: {
      first_name: "name_part:first",
      last_name: "name_part:last",
      phone: "phone",
      email: "email",
      ig_username: "instagram",
    },
  },
};

const target = (c: ColumnMap) =>
  c.to === "field" ? c.field : c.to === "name_part" ? `name_part:${c.part}` : null;

/** The preset's own paths first, custom_fields.<key> next, then the usual guess on each path's last segment. */
export function presetMapping(preset: Preset, headers: string[], fields: IntakeField[]): Mapping {
  const last = headers.map((h) => h.replace(/\[\]$/, "").split(".").at(-1)!);
  const guess = suggestMapping(last, fields, null);
  const custom = fields.filter((f) => !f.isCore && !f.archived && f.access === "edit");
  const chosen = new Map<number, ColumnMap>();
  headers.forEach((h, column) => {
    const to = PRESETS[preset].paths[h];
    if (to?.startsWith("name_part:"))
      return void chosen.set(column, { column, to: "name_part", part: to.slice(10) as "first" | "last" });
    if (to) return void chosen.set(column, { column, to: "field", field: to });
    const m = /^custom_fields\.(.+)$/.exec(h);
    if (m) {
      const k = m[1]!;
      const f = custom.find((x) => x.key === k || fold(x.label) === fold(k));
      chosen.set(column, f ? { column, to: "field", field: f.key } : { column, to: "ignore" });
    }
  });
  const taken = new Set([...chosen.values()].map(target).filter(Boolean));
  // A guessed column never takes a target a chosen one already has.
  const columns = guess.columns.map((c) => {
    const pick = chosen.get(c.column);
    if (pick) return pick;
    const t = target(c);
    return t && taken.has(t) ? { column: c.column, to: "ignore" as const } : c;
  });
  return { ...guess, columns };
}
