import type { PermissionKey } from "../rbac/catalog";
import { can, type Actor } from "../rbac/engine";
import type { Capabilities } from "../onboarding/steps";

/** Raise this when a later phase adds screens: people then see only the new steps, once (spec §5). */
export const TOUR_VERSION = 1;

export type TourStep = {
  id: string;
  /** Matches a `data-tour="…"` attribute in the app. A test asserts every target exists. */
  target: string;
  title: string;
  /** One sentence. Module names wrapped in ** ** render bold. */
  body: string;
  placement: "right" | "bottom";
  permission: PermissionKey | null;
  needsCapability?: "sheets" | "calendar";
  ownerOrAdmin?: true;
};

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "lume",
    target: "brand",
    title: "This is LUME",
    body: "Every lead, follow-up and call in one place. You move around from this sidebar.",
    placement: "right",
    permission: null,
  },
  {
    id: "today",
    target: "nav-today",
    title: "Start on Today",
    body: "**Today** is your list: follow-ups due, new replies and calls booked. Nothing else.",
    placement: "right",
    permission: null,
  },
  {
    id: "leads",
    target: "nav-leads",
    title: "Leads is the full list",
    body: "**Leads** holds everyone you own. Filter, sort, edit in place, or pick many at once.",
    placement: "right",
    permission: "leads.view",
  },
  {
    id: "pipeline",
    target: "nav-pipeline",
    title: "Pipeline is the board",
    body: "**Pipeline** shows your stages side by side. Drag a lead to move it along.",
    placement: "right",
    permission: "leads.view",
  },
  {
    id: "reveal",
    target: "nav-leads",
    title: "Contacts stay hidden",
    body: "Numbers and emails are masked. **Reveal** shows one lead’s details, and records that you looked.",
    placement: "right",
    permission: "leads.contact.reveal",
  },
  {
    id: "calendar",
    target: "nav-calendar",
    title: "Calendar shows lead calls",
    body: "**Calendar** pulls your Google Calendar and shows only meetings with leads.",
    placement: "right",
    permission: "calendar.view",
    needsCapability: "calendar",
  },
  {
    id: "templates",
    target: "nav-templates",
    title: "Templates write for you",
    body: "**Templates** are approved messages with the lead’s details filled in automatically.",
    placement: "right",
    permission: "templates.use",
  },
  {
    id: "analytics",
    target: "nav-analytics",
    title: "Analytics shows what works",
    body: "**Analytics** answers where leads come from, where they stall and what you won.",
    placement: "right",
    permission: "analytics.view",
  },
  {
    id: "search",
    target: "search",
    title: "Jump anywhere",
    body: "Press **Ctrl K** to find a lead by name or run an action, from any screen.",
    placement: "bottom",
    permission: null,
  },
  {
    id: "notifications",
    target: "notifications",
    title: "Reminders land here",
    body: "The bell holds your reminders and new replies. Act on them without leaving the page.",
    placement: "bottom",
    permission: null,
  },
  {
    id: "people",
    target: "nav-settings",
    title: "People and roles",
    body: "In **Settings**, invite people and choose what each role may see. Sales see only their own leads.",
    placement: "right",
    permission: "users.manage",
  },
  {
    id: "audit",
    target: "nav-settings",
    title: "Audit log",
    body: "**Settings** also holds the audit log: every sign-in, reveal and change, and nobody can edit it.",
    placement: "right",
    permission: "audit.view",
  },
  {
    id: "settings",
    target: "nav-settings",
    title: "Settings is yours too",
    body: "**Settings** keeps your timezone, theme, alerts and this tour. Change them any time.",
    placement: "right",
    permission: null,
  },
  {
    id: "me",
    target: "profile",
    title: "That’s LUME",
    body: "Your profile, theme and sign-out live here. Replay this tour any time from **Settings**.",
    placement: "right",
    permission: null,
  },
];

export function tourStepsFor(actor: Actor, capabilities: Capabilities): TourStep[] {
  return TOUR_STEPS.filter((s) => {
    if (s.needsCapability && !capabilities[s.needsCapability]) return false;
    return s.permission === null || can(actor, s.permission);
  });
}

export type TourState = {
  version: number;
  step: number;
  completedAt: string | null;
  skippedAt: string | null;
};
export const EMPTY_TOUR: TourState = { version: 0, step: 0, completedAt: null, skippedAt: null };

/** Needed when never finished or skipped, or when the tour has new steps since. */
export const needsTour = (state: TourState): boolean =>
  state.version !== TOUR_VERSION || (state.completedAt === null && state.skippedAt === null);

/** Split "Press **Ctrl K** to search" into plain and bold runs. No HTML is ever interpreted. */
export function boldParts(body: string): Array<{ text: string; bold: boolean }> {
  return body
    .split(/\*\*(.+?)\*\*/g)
    .map((text, i) => ({ text, bold: i % 2 === 1 }))
    .filter((p) => p.text.length > 0);
}
