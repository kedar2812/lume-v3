/**
 * Timezone, currency and country lists built from the platform's own Intl data — nothing bundled,
 * so the lists stay correct as the browser's ICU is updated (spec §4.2: the timezone is what every
 * "today", digest and reminder in LUME is measured against, so it has to be a real IANA id).
 */
export type TimezoneOption = { id: string; label: string; offset: string };

const supportedValues = (key: string): string[] => {
  const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  try {
    return fn ? fn(key) : [];
  } catch {
    return [];
  }
};

/** "UTC+4" — the short offset as people write it, at the given moment (so DST is included). */
export function formatOffset(id: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: id, timeZoneName: "shortOffset" }).formatToParts(
    at,
  );
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name.replace("GMT", "UTC").replace(/^UTC$/, "UTC+0");
}

/**
 * ICU still reports a few zones by their pre-rename ids. Both are valid IANA ids, but people know
 * the city by its current name, so offer that one.
 */
const RENAMED: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Godthab": "America/Nuuk",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/** The city is what people recognise; the full id stays searchable. */
const labelOf = (id: string): string => id.split("/").at(-1)!.replace(/_/g, " ");

let zones: TimezoneOption[] | null = null;
export function timezoneOptions(): TimezoneOption[] {
  if (!zones) {
    const ids = supportedValues("timeZone");
    // A browser without supportedValuesOf still has to be able to finish setup.
    const found = ids.length ? ids : ["Asia/Dubai", "Asia/Kolkata", "Europe/London", "America/New_York"];
    // UTC is not a place, so ICU leaves it out; it is still a sensible choice for a server-minded owner.
    const list = [...new Set(["UTC", ...found.map((id) => RENAMED[id] ?? id)])];
    zones = list
      .map((id) => ({ id, label: labelOf(id), offset: formatOffset(id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  return zones;
}

export function searchTimezones(q: string): TimezoneOption[] {
  const term = q.trim().toLowerCase();
  if (!term) return timezoneOptions();
  // "utc+04", "+04" and "+4" all mean the same thing to a person typing an offset.
  const asOffset = term.replace(/^utc/, "").replace(/^([+-])0(\d)$/, "$1$2");
  return timezoneOptions().filter(
    (z) =>
      z.label.toLowerCase().includes(term) ||
      z.id.toLowerCase().includes(term) ||
      z.offset.toLowerCase().replace("utc", "") === asOffset,
  );
}

/** The browser's own zone, but only if it is one we can offer; otherwise a safe default. */
export function guessTimezone(): string {
  const raw = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const guess = RENAMED[raw] ?? raw;
  return timezoneOptions().some((z) => z.id === guess) ? guess : "UTC";
}

/** The current time in a zone, so the choice can be checked at a glance. */
export function localTime(id: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: id, hour: "numeric", minute: "2-digit" })
    .format(at)
    .replace(/[\u202f\u00a0]/g, " ") // ICU writes a narrow no-break space before AM/PM
    .toLowerCase();
}
