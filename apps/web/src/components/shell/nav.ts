export type IconName = "today" | "leads" | "pipeline" | "calendar" | "templates" | "analytics" | "settings";
export type NavItem = {
  id: IconName;
  label: string;
  href: string;
  icon: IconName;
  permission?: string;
  phase: number;
};

/** Order matters: it drives page-transition direction (spec §5.3). `phase` = report build phase that fills it. */
export const NAV_ITEMS: NavItem[] = [
  { id: "today", label: "Today", href: "/today", icon: "today", phase: 3 },
  { id: "leads", label: "Leads", href: "/leads", icon: "leads", permission: "leads.view", phase: 1 },
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
    permission: "settings.manage",
    phase: 1,
  },
];

export const visibleNav = (items: NavItem[], can: (p: string) => boolean) =>
  items.filter((i) => !i.permission || can(i.permission));

export const activeNav = (items: NavItem[], pathname: string) =>
  items.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));

export function navDirection(items: NavItem[], from: string, to: string): 1 | -1 | 0 {
  const a = items.indexOf(activeNav(items, from)!);
  const b = items.indexOf(activeNav(items, to)!);
  if (a < 0 || b < 0 || a === b) return 0;
  return b > a ? 1 : -1;
}
