export type Scope = "own" | "team" | "all";
export const SCOPE_RANK: Record<Scope, number> = { own: 1, team: 2, all: 3 };

/**
 * Report §7.2. Permissions live in code because each one corresponds to code that checks it; roles are data.
 * Adding a key here makes it appear in the roles screen on the next boot (synced to the permissions table).
 */
export const PERMISSIONS = [
  {
    key: "leads.view",
    group: "Leads",
    scoped: true,
    label: "See leads",
    description: "Open the leads list and lead pages",
  },
  {
    key: "leads.create",
    group: "Leads",
    scoped: false,
    label: "Create leads",
    description: "Add leads by hand",
  },
  {
    key: "leads.edit",
    group: "Leads",
    scoped: true,
    label: "Edit leads",
    description: "Change fields and add notes",
  },
  {
    key: "leads.delete",
    group: "Leads",
    scoped: true,
    label: "Delete leads",
    description: "Move leads to the bin",
  },
  {
    key: "leads.assign",
    group: "Leads",
    scoped: true,
    label: "Assign leads to people",
    description: "Hand leads to a teammate",
  },
  {
    key: "leads.change_stage",
    group: "Leads",
    scoped: true,
    label: "Move leads between stages",
    description: "Drag on the board or change stage",
  },
  {
    key: "leads.contact.full",
    group: "Contact details",
    scoped: true,
    label: "See full contact details",
    description: "Phone, email and Instagram unmasked",
  },
  {
    key: "leads.contact.reveal",
    group: "Contact details",
    scoped: true,
    label: "Reveal one lead's contact",
    description: "Each reveal is logged and counted",
  },
  {
    key: "leads.bulk_edit",
    group: "Leads",
    scoped: true,
    label: "Bulk edit",
    description: "Change stage, tags or fields for many leads",
  },
  {
    key: "leads.export",
    group: "Leads",
    scoped: true,
    label: "Export to spreadsheet",
    description: "Download leads as a CSV file",
  },
  {
    key: "leads.import",
    group: "Leads",
    scoped: false,
    label: "Import leads",
    description: "CSV import and lead sources",
  },
  {
    key: "messages.send",
    group: "Messaging",
    scoped: true,
    label: "Send WhatsApp messages",
    description: "One click, from approved templates",
  },
  {
    key: "messages.send_queue",
    group: "Messaging",
    scoped: true,
    label: "Use the send queue",
    description: "Message many leads one after another",
  },
  {
    key: "templates.use",
    group: "Messaging",
    scoped: false,
    label: "Use templates",
    description: "Pick templates when messaging",
  },
  {
    key: "templates.manage",
    group: "Messaging",
    scoped: false,
    label: "Manage templates",
    description: "Create and edit templates",
  },
  {
    key: "tasks.manage_others",
    group: "Tasks",
    scoped: true,
    label: "Manage others' follow-ups",
    description: "Create and edit tasks for other people",
  },
  {
    key: "calendar.view",
    group: "Insight",
    scoped: true,
    label: "See lead meetings",
    description: "Calendar with lead calls only",
  },
  {
    key: "calendar.connect",
    group: "Insight",
    scoped: false,
    label: "Connect a calendar",
    description: "Connect their own Google Calendar",
  },
  {
    key: "analytics.view",
    group: "Insight",
    scoped: true,
    label: "See analytics",
    description: "Charts and numbers",
  },
  {
    key: "analytics.revenue",
    group: "Insight",
    scoped: false,
    label: "See revenue",
    description: "Money figures in analytics",
  },
  {
    key: "pipelines.manage",
    group: "Admin",
    scoped: false,
    label: "Manage pipelines",
    description: "Pipelines and stages",
  },
  {
    key: "fields.manage",
    group: "Admin",
    scoped: false,
    label: "Manage fields",
    description: "Custom fields",
  },
  {
    key: "settings.manage",
    group: "Admin",
    scoped: false,
    label: "Change settings",
    description: "Business settings",
  },
  {
    key: "users.manage",
    group: "Admin",
    scoped: false,
    label: "Manage people",
    description: "Invite, disable, change access",
  },
  {
    key: "roles.manage",
    group: "Admin",
    scoped: false,
    label: "Manage roles",
    description: "Create roles and set permissions",
  },
  {
    key: "teams.manage",
    group: "Admin",
    scoped: false,
    label: "Manage teams",
    description: "Teams and team leads",
  },
  {
    key: "integrations.manage",
    group: "Admin",
    scoped: false,
    label: "Manage integrations",
    description: "Sheets, Calendly, webhooks",
  },
  {
    key: "audit.view",
    group: "Security",
    scoped: false,
    label: "See the audit log",
    description: "Who did what, when",
  },
  {
    key: "security.manage",
    group: "Security",
    scoped: false,
    label: "Manage security",
    description: "Sessions, 2FA policy, alerts",
  },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];
export type PermissionDef = (typeof PERMISSIONS)[number];
const KEYS = new Set<string>(PERMISSIONS.map((p) => p.key));
export const isPermissionKey = (s: string): s is PermissionKey => KEYS.has(s);
export const permissionDef = (k: PermissionKey): PermissionDef => PERMISSIONS.find((p) => p.key === k)!;
