import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness";

/**
 * Phase 9 Task 5, the security pass: every table the app's role can reach has row-level security, so a missed
 * WHERE in some future query can never show one person another's rows. A table that deliberately has none is
 * named here with why; a new table without either fails this test.
 */
const WITHOUT_RLS: Record<string, string> = {
  // Business configuration: readable by everyone signed in, written only through permission-checked routes
  field_definitions: "Business configuration",
  lost_reasons: "Business configuration",
  message_templates: "Business configuration",
  template_versions: "Business configuration",
  pipelines: "Business configuration",
  stages: "Business configuration",
  products: "Business configuration",
  tags: "Business configuration",
  teams: "Business configuration",
  team_members: "Business configuration",
  roles: "Business configuration",
  role_permissions: "Business configuration",
  role_field_access: "Business configuration",
  permissions: "Business configuration",
  user_roles: "Business configuration",
  settings: "Business configuration",
  lead_sources: "Business configuration",
  goals: "Business configuration",
  licence_state: "Business configuration",
  // People and accounts: no lead data; each route returns only what the caller's role allows
  users: "People and accounts",
  user_invites: "People and accounts",
  user_avatars: "People and accounts",
  legal_acceptances: "People and accounts",
  // Sign-in and security internals: read by the auth code for the caller's own row, or by security.manage routes
  sessions: "Sign-in and security internals",
  password_resets: "Sign-in and security internals",
  recovery_codes: "Sign-in and security internals",
  auth_throttle: "Sign-in and security internals",
  crypto_keys: "Sign-in and security internals",
  idempotency_keys: "Sign-in and security internals",
  oauth_connects: "Sign-in and security internals",
  security_alerts: "Sign-in and security internals",
  audit_log: "Sign-in and security internals",
  reveal_counters: "Sign-in and security internals",
  // Background work and its bookkeeping: written and read by the worker, never listed to a person whole
  bulk_runs: "Background work and its bookkeeping",
  bulk_run_items: "Background work and its bookkeeping",
  digest_runs: "Background work and its bookkeeping",
  scheduled_notifications: "Background work and its bookkeeping",
  ops_events: "Background work and its bookkeeping",
  ops_restore_tests: "Background work and its bookkeeping",
  schema_migrations: "Background work and its bookkeeping",
  source_refreshes: "Background work and its bookkeeping",
  source_syncs: "Background work and its bookkeeping",
  webhook_events: "Background work and its bookkeeping",
  analytics_insight_seen: "Background work and its bookkeeping",
  weekly_runs: "Background work and its bookkeeping",
  webhook_signatures: "Background work and its bookkeeping",
  // Derived from leads, only ever read joined to leads (whose RLS decides) or through lume_lead_search; contact keys are hashes
  lead_firsts:
    "Derived from leads, only ever read joined to leads (whose RLS decides) or through lume_lead_search; contact keys are hashes",
  lead_search:
    "Derived from leads, only ever read joined to leads (whose RLS decides) or through lume_lead_search; contact keys are hashes",
  lead_contact_keys:
    "Derived from leads, only ever read joined to leads (whose RLS decides) or through lume_lead_search; contact keys are hashes",
  // Import working data: seen only by people who import (leads.import), each import's own rows
  imports: "Import working data",
  import_rows: "Import working data",
  import_mapping_memory: "Import working data",
  source_rows: "Import working data",
  // Sealed export files: listed to security.manage, downloaded only by the person who made them
  lead_exports: "Sealed export files",
};

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe("row-level security covers every table (Phase 9 Task 5)", () => {
  it("each table in public has RLS on, or is named above with its reason", async () => {
    const { rows } = await h.ownerPool.query<{ name: string; rls: boolean }>(`
      SELECT c.relname AS name, c.relrowsecurity AS rls
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       ORDER BY 1`);
    const missing = rows.filter((r) => !r.rls && !(r.name in WITHOUT_RLS)).map((r) => r.name);
    expect(missing).toEqual([]);
    // And the named ones still exist (a stale entry would hide a renamed table).
    const names = new Set(rows.map((r) => r.name));
    expect(Object.keys(WITHOUT_RLS).filter((n) => !names.has(n))).toEqual([]);
  });
});
