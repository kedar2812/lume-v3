export type IconName =
  | "today"
  | "leads"
  | "replies"
  | "autopilot"
  | "pipeline"
  | "calendar"
  | "templates"
  | "media"
  | "analytics"
  | "settings";
export type NavItem = {
  id: IconName;
  label: string;
  href: string;
  icon: IconName;
  permission?: string;
  /** Shown only while this is on for the person: LUME AI (Autopilot A3). */
  needs?: "ai";
  phase: number;
};

/** Order matters: it drives page-transition direction (spec §5.3). `phase` = report build phase that fills it. */
export const NAV_ITEMS: NavItem[] = [
  { id: "today", label: "Today", href: "/today", icon: "today", phase: 3 },
  { id: "leads", label: "Leads", href: "/leads", icon: "leads", permission: "leads.view", phase: 1 },
  // WhatsApp replies grouped by what they mean (W2; owner, 2026-10-25: in the sidebar), for whoever may view leads.
  {
    id: "replies",
    label: "Who replied",
    href: "/replies",
    icon: "replies",
    permission: "leads.view",
    phase: 12,
  },
  {
    // LUME AI working leads live (Autopilot spec 2026-10-19 §2), named LUME AI everywhere (owner, 2026-10-27): whoever
    // may view leads, on or off; off, its page says how to switch it on.
    id: "autopilot",
    label: "LUME AI",
    href: "/autopilot",
    icon: "autopilot",
    permission: "leads.view",
    phase: 11,
  },
  {
    id: "pipeline",
    label: "Pipeline",
    href: "/pipeline",
    icon: "pipeline",
    permission: "leads.view",
    phase: 1,
  },
  {
    id: "calendar",
    label: "Calendar",
    href: "/calendar",
    icon: "calendar",
    permission: "calendar.view",
    phase: 5,
  },
  {
    id: "templates",
    label: "Templates",
    href: "/templates",
    icon: "templates",
    permission: "templates.use",
    phase: 4,
  },
  {
    // The business's files (plan 2026-10-20-media-tab): everyone who sends templates sends these too.
    id: "media",
    label: "Media",
    href: "/media",
    icon: "media",
    permission: "templates.use",
    phase: 10,
  },
  {
    id: "analytics",
    label: "Analytics",
    href: "/analytics",
    icon: "analytics",
    permission: "analytics.view",
    phase: 7,
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    icon: "settings",
    // Everyone: personal settings, two-step sign-in and the tour live here; admin pages gate themselves.
    phase: 1,
  },
];

export const visibleNav = (items: NavItem[], can: (p: string) => boolean, on: { ai?: boolean } = {}) =>
  items.filter((i) => (!i.permission || can(i.permission)) && (i.needs !== "ai" || on.ai === true));

export const activeNav = (items: NavItem[], pathname: string) =>
  items.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));

export function navDirection(items: NavItem[], from: string, to: string): 1 | -1 | 0 {
  const a = items.indexOf(activeNav(items, from)!);
  const b = items.indexOf(activeNav(items, to)!);
  if (a < 0 || b < 0 || a === b) return 0;
  return b > a ? 1 : -1;
}
