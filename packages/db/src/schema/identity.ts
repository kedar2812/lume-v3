import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  char,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({ dataType: () => "citext" });
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const inet = customType<{ data: string }>({ dataType: () => "inet" });
const cidrArray = customType<{ data: string[] }>({ dataType: () => "cidr[]" });
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const settings = pgTable("settings", {
  id: smallint("id").primaryKey().default(1),
  businessName: text("business_name").notNull(),
  logoAssetId: uuid("logo_asset_id"),
  timezone: text("timezone").notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  defaultCountryIso: char("default_country_iso", { length: 2 }).notNull(),
  weekStart: smallint("week_start").notNull().default(1),
  workingHours: jsonb("working_hours")
    .notNull()
    .default(sql`'{}'::jsonb`),
  digestDefaultTime: time("digest_default_time").notNull().default("08:00"),
  industryPreset: text("industry_preset").notNull(),
  security: jsonb("security")
    .$type<SecuritySettings>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  retention: jsonb("retention")
    .notNull()
    .default(sql`'{}'::jsonb`),
  fieldDefsVersion: integer("field_defs_version").notNull().default(0),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export type SecuritySettings = {
  sessionIdleHours?: number;
  sessionAbsoluteDays?: number;
  requireTwoFactorForAll?: boolean;
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: citext("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  status: text("status").$type<"invited" | "active" | "disabled">().notNull(),
  isOwner: boolean("is_owner").notNull().default(false),
  timezone: text("timezone"),
  theme: text("theme").$type<"system" | "porcelain" | "obsidian">().notNull().default("system"),
  totpSecretEnc: bytea("totp_secret_enc"),
  totpPendingEnc: bytea("totp_pending_enc"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  totpLastStep: bigint("totp_last_step", { mode: "number" }),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  lastLoginAt: tz("last_login_at"),
  disabledAt: tz("disabled_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export type LoginHours = { days: number[]; from: string; to: string }; // business timezone, "HH:MM"

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey(),
  name: citext("name").notNull(),
  description: text("description").notNull().default(""),
  color: text("color").notNull().default("accent"),
  loginHours: jsonb("login_hours").$type<LoginHours | null>(),
  ipAllowlist: cidrArray("ip_allowlist"),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  deletedAt: tz("deleted_at"),
});

export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  group: text("group").notNull(),
  label: text("label").notNull(),
  description: text("description").notNull(),
  supportsScope: boolean("supports_scope").notNull(),
  retired: boolean("retired").notNull().default(false),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id").notNull(),
    permissionKey: text("permission_key").notNull(),
    scope: text("scope").$type<"own" | "team" | "all" | null>(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const userRoles = pgTable(
  "user_roles",
  { userId: uuid("user_id").notNull(), roleId: uuid("role_id").notNull() },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey(),
  name: citext("name").notNull(),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  deletedAt: tz("deleted_at"),
});

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id").notNull(),
    isLead: boolean("is_lead").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  stage: text("stage").$type<"mfa" | "full">().notNull(),
  ip: inet("ip"),
  userAgent: text("user_agent"),
  createdAt: tz("created_at").notNull().defaultNow(),
  lastSeenAt: tz("last_seen_at").notNull().defaultNow(),
  expiresAt: tz("expires_at").notNull(),
  revokedAt: tz("revoked_at"),
  revokedReason: text("revoked_reason"),
});

export const recoveryCodes = pgTable("recovery_codes", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  codeHash: text("code_hash").notNull(),
  usedAt: tz("used_at"),
});

export const userInvites = pgTable("user_invites", {
  id: uuid("id").primaryKey(),
  email: citext("email").notNull(),
  name: text("name").notNull(),
  roleIds: uuid("role_ids").array().notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: tz("expires_at").notNull(),
  acceptedAt: tz("accepted_at"),
  revokedAt: tz("revoked_at"),
  invitedBy: uuid("invited_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const passwordResets = pgTable("password_resets", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: tz("expires_at").notNull(),
  usedAt: tz("used_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const authThrottle = pgTable("auth_throttle", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStartedAt: tz("window_started_at").notNull().defaultNow(),
  nextAllowedAt: tz("next_allowed_at"),
  lockedUntil: tz("locked_until"),
  lockouts: integer("lockouts").notNull().default(0),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export const cryptoKeys = pgTable("crypto_keys", {
  id: uuid("id").primaryKey(),
  wrapped: bytea("wrapped").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: tz("at").notNull().defaultNow(),
  actorUserId: uuid("actor_user_id"),
  actorIp: inet("actor_ip"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  diff: jsonb("diff")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  requestId: text("request_id"),
});
