import type { SettingsArea } from "./areas";

/**
 * One thing a person can look for in Settings: the setting's own name, the words someone might type for it, and the
 * area it lives in. `anchor` is the id on that page where it sits (the page scrolls to it and glows once).
 */
export type SettingsEntry = { area: string; label: string; keywords: string[]; anchor?: string };

/** The settings inside each area, by the names their pages give them. An area itself is always findable too. */
export const SETTINGS_ENTRIES: SettingsEntry[] = [
  { area: "business", label: "Business name", keywords: ["company", "brand", "workspace name"] },
  { area: "business", label: "Timezone", keywords: ["time zone", "clock", "region"] },
  { area: "business", label: "Currency", keywords: ["money", "inr", "aed", "usd", "exchange"] },
  { area: "business", label: "Country", keywords: ["phone numbers", "dialling code", "country code"] },
  { area: "business", label: "Week starts on", keywords: ["monday", "sunday", "calendar week"] },
  { area: "pipeline", label: "Stages", keywords: ["funnel", "steps", "columns", "board"] },
  { area: "pipeline", label: "Stage colours", keywords: ["color", "colour"] },
  {
    area: "pipeline",
    label: "Hours a lead may sit in a stage",
    keywords: ["sla", "stuck", "overdue", "allowed time"],
  },
  { area: "pipeline", label: "Win chance", keywords: ["probability", "forecast", "likelihood"] },
  { area: "pipeline", label: "Required fields", keywords: ["mandatory", "must fill"] },
  { area: "pipeline", label: "Stage automations", keywords: ["when a lead enters", "rules", "auto"] },
  {
    area: "calendar-rules",
    label: "Which events are meetings",
    keywords: ["attendee", "title has a word", "calendar rules"],
  },
  { area: "calendar-rules", label: "Booking stage", keywords: ["call booked", "move lead"] },
  { area: "fields", label: "Custom fields", keywords: ["field", "form", "budget", "dropdown", "lead form"] },
  { area: "lists", label: "Lost reasons", keywords: ["why lost", "reasons"] },
  { area: "lists", label: "Tags", keywords: ["labels", "label"] },
  { area: "lists", label: "Packages", keywords: ["products", "plans", "price"] },
  { area: "follow-ups", label: "Overdue follow-ups", keywords: ["escalation", "tell managers", "reminders"] },
  { area: "follow-ups", label: "Morning emails", keywords: ["digest", "daily email", "send it at"] },
  { area: "follow-ups", label: "Leads gone quiet", keywords: ["no reply", "bring back", "stale"] },
  { area: "follow-ups", label: "Working hours", keywords: ["office hours", "weekends", "business hours"] },
  {
    area: "follow-ups",
    label: "Time choices",
    keywords: ["due presets", "snooze", "later today", "tomorrow"],
  },
  { area: "messages", label: "The send queue", keywords: ["whatsapp", "bulk send", "leads in a run"] },
  { area: "messages", label: "A daily limit", keywords: ["cap", "messages per day", "limit"] },
  { area: "health", label: "Background jobs", keywords: ["reminders running", "worker", "status"] },
  { area: "health", label: "Backups", keywords: ["restore test", "backup"] },
  { area: "imports", label: "Past imports", keywords: ["csv", "excel", "upload", "import report"] },
  { area: "integrations", label: "Google Sheets", keywords: ["sheet", "spreadsheet", "sync"] },
  { area: "integrations", label: "Webhooks", keywords: ["zapier", "make", "website form", "api"] },
  { area: "integrations", label: "Calendly", keywords: ["booking", "scheduling"] },
  { area: "people", label: "Invite someone", keywords: ["add user", "new member", "teammate"] },
  {
    area: "people",
    label: "Disable or offboard",
    keywords: ["remove user", "leaver", "deactivate", "hand over leads"],
  },
  {
    area: "roles",
    label: "What each role can do",
    keywords: ["permissions", "access", "admin", "sales rep"],
  },
  { area: "roles", label: "Field access", keywords: ["hide field", "masked", "read only"] },
  { area: "teams", label: "Team leads", keywords: ["manager", "team members", "group"] },
  { area: "security", label: "Security alerts", keywords: ["scraping", "suspicious", "contacts opened"] },
  { area: "security", label: "On-screen watermark", keywords: ["watermark", "screenshot"] },
  { area: "security", label: "Exports", keywords: ["downloads", "trace a file", "csv export"] },
  { area: "security", label: "Sign-in hours", keywords: ["login hours", "ip allowlist", "who can sign in"] },
  { area: "audit", label: "Audit entries", keywords: ["history", "who did what", "log"] },
  {
    area: "calendar",
    label: "Google Calendar",
    keywords: ["connect calendar", "which calendars", "refresh"],
  },
  { area: "account", label: "Your name and photo", keywords: ["profile", "avatar", "initials colour"] },
  { area: "account", label: "Your password", keywords: ["change password", "reset"] },
  { area: "account", label: "Two-step sign-in", keywords: ["2fa", "authenticator", "otp", "mfa"] },
  {
    area: "account",
    label: "Where you're signed in",
    keywords: ["sessions", "devices", "sign out everywhere"],
  },
  { area: "account", label: "Notifications", keywords: ["alerts", "tell me when", "sounds"] },
  { area: "account", label: "The tour", keywords: ["help", "walkthrough", "getting started"] },
  { area: "about", label: "About LUME", keywords: ["version", "update", "licence", "license"] },
  { area: "about", label: "Licence", keywords: ["license", "plan", "check now", "payment"] },
  { area: "about", label: "Export all data", keywords: ["download everything", "backup", "your data"] },
];

export type SettingsHit = {
  id: string;
  label: string;
  /** Where it lives ("Business", or "People · Stage" for one of yours). */
  where: string;
  href: string;
  keywords: string[];
  kind: "area" | "setting" | "yours";
};

/** Everything findable for this person: each area they may open, and the settings inside those areas. */
export function settingsHits(areas: SettingsArea[]): SettingsHit[] {
  const byId = new Map(areas.map((a) => [a.id, a]));
  const hits: SettingsHit[] = areas.map((a) => ({
    id: `area:${a.id}`,
    label: a.title,
    where: "Settings",
    href: a.href,
    keywords: [a.blurb],
    kind: "area",
  }));
  for (const e of SETTINGS_ENTRIES) {
    const a = byId.get(e.area);
    if (!a) continue;
    hits.push({
      id: `setting:${e.area}:${e.label}`,
      label: e.label,
      where: a.title,
      href: e.anchor ? `${a.href}#${e.anchor}` : a.href,
      keywords: e.keywords,
      kind: "setting",
    });
  }
  return hits;
}
