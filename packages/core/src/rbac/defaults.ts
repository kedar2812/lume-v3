import { ALL_GRANTS, type Grant } from "./engine";

export type RoleSeed = { name: string; description: string; color: string; grants: Grant[] };

/** Seeded at first-run setup; ordinary, editable, deletable roles afterwards (report §7.1). */
export const DEFAULT_ROLES: RoleSeed[] = [
  { name: "Admin", description: "Sees and controls everything", color: "accent", grants: ALL_GRANTS },
  {
    name: "Sales",
    description: "Works their own leads; contact details masked with Reveal",
    color: "ok",
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "leads.edit", scope: "own" },
      { key: "leads.change_stage", scope: "own" },
      { key: "leads.contact.reveal", scope: "own" },
      { key: "messages.send", scope: "own" },
      { key: "templates.use", scope: null },
      { key: "calendar.view", scope: "own" },
      { key: "calendar.connect", scope: null },
      { key: "analytics.view", scope: "own" },
    ],
  },
];
