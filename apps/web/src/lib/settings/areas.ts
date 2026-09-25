import { can, type Actor, type PermissionKey } from "@lume/core/shared";

export type SettingsArea = {
  id: string;
  title: string;
  blurb: string;
  href: string;
  /** Shown to anyone holding any one of these ("auth.self": everyone signed in). */
  anyOf: (PermissionKey | "auth.self")[];
  group: "workspace" | "people" | "you";
};

/** Every Settings area, in the order the home and the section nav show them (spec §7). */
export const SETTINGS_AREAS: SettingsArea[] = [
  {
    id: "business",
    title: "Business",
    blurb: "Name, timezone, currency and country",
    href: "/settings/business",
    anyOf: ["settings.manage"],
    group: "workspace",
  },
  {
    id: "pipeline",
    title: "Pipeline & stages",
    blurb: "The steps a lead moves through, their colours and what each needs",
    href: "/settings/pipeline",
    anyOf: ["pipelines.manage"],
    group: "workspace",
  },
  {
    id: "fields",
    title: "Fields",
    blurb: "What you record about every lead, with a live preview",
    href: "/settings/fields",
    anyOf: ["fields.manage"],
    group: "workspace",
  },
  {
    id: "lists",
    title: "Lost reasons, tags & packages",
    blurb: "The short lists people pick from",
    href: "/settings/lists",
    anyOf: ["pipelines.manage", "settings.manage"],
    group: "workspace",
  },
  {
    id: "people",
    title: "People",
    blurb: "Invite, disable, and hand leads over",
    href: "/settings/people",
    anyOf: ["users.manage"],
    group: "people",
  },
  {
    id: "roles",
    title: "Roles & access",
    blurb: "What each role can see and do, down to single fields",
    href: "/settings/roles",
    anyOf: ["roles.manage"],
    group: "people",
  },
  {
    id: "teams",
    title: "Teams",
    blurb: "Who works together, and who leads them",
    href: "/settings/teams",
    anyOf: ["teams.manage"],
    group: "people",
  },
  {
    id: "audit",
    title: "Audit log",
    blurb: "Everything important that happened, and who did it",
    href: "/settings/audit",
    anyOf: ["audit.view"],
    group: "people",
  },
  {
    id: "account",
    title: "My account",
    blurb: "Your sessions, two-step sign-in and the tour",
    href: "/settings/account",
    anyOf: ["auth.self"],
    group: "you",
  },
  {
    id: "about",
    title: "About",
    blurb: "Version and backups",
    href: "/settings/about",
    anyOf: ["auth.self"],
    group: "you",
  },
];

export const GROUP_TITLES: Record<SettingsArea["group"], string> = {
  workspace: "Your workspace",
  people: "People and access",
  you: "You",
};

export const areasFor = (actor: Actor): SettingsArea[] =>
  SETTINGS_AREAS.filter((a) => a.anyOf.some((k) => k === "auth.self" || can(actor, k)));

export const areaById = (id: string): SettingsArea => SETTINGS_AREAS.find((a) => a.id === id)!;
