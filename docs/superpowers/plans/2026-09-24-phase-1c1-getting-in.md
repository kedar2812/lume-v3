# Phase 1C-1 — Getting In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every way into LUME, working against the real API: first-run setup, sign-in with two-step codes and recovery codes, invite acceptance, password reset, the per-person onboarding, and the spotlight product tour — with the web app finally wired to real sessions and real permissions.

**Architecture:** Pages render on the server and fetch through one helper that forwards the visitor's session cookie to the API (`http://api:3001`). `getSession()` (memoised per request) returns the signed-in person, their permissions and their onboarding/tour state; the shell, nav and every gate read from it. Mutations go from the browser to the same-origin `/api/v1` with the CSRF header and an `Idempotency-Key`, then `router.refresh()`. The onboarding step list and the tour step list live in `packages/core`, so the API (which decides *whether* onboarding is needed) and the web app (which renders it) can never disagree.

**Tech Stack:** Next.js 16 App Router (server components), React 19, motion/react springs, CSS Modules with the approved tokens, Fastify 5 + Zod 4 API (built in 1A/1B), Postgres 17, Playwright (full stack: API + web behind a small edge proxy, with an SMTP sink).

**Spec:** `docs/superpowers/specs/2026-09-24-phase-1c-screens-design.md` (read §3 architecture, §4 onboarding, §5 tour, §8 quality bars). Also `docs/superpowers/specs/2026-09-21-lume-frontend-design.md` (visual system) and `docs/LUME_PROJECT_REPORT.md` §4.4, §12.2, §15.3, §16.

## Global Constraints

- Everything from Plan 1A/1B's Global Constraints still applies: `main` only, the **strict gate** before every commit (`scripts/dev.sh run bash -c 'pnpm lint && pnpm typecheck && pnpm test'`, exiting non-zero on any failure), push after each task and watch CI, build-host rules (containers only, 127.0.0.1 ports), and fail closed.
- **The API is the authority.** Hiding a control in the UI is never a control: every server render fetches through the API, which enforces permissions and returns 404 for out-of-scope records. Never re-implement a rule in the browser — import `can`, `scopeOf`, `canOnRecord` from `@lume/core`.
- **The logo is the owner's file.** `public/lume-mark.png` is used as-is. Never generate, trace, resize or re-export it.
- **Third-party marks** (Google Calendar, Google Sheets, Google "G") are Google's official files, added unmodified under `apps/web/public/brand/`, and never recoloured or redrawn.
- **Scrollbars** follow the app rule already in `base.css` (thin, token-coloured, hover/scroll only). Any new scroll container gets the soft fade where content meets fixed controls. Never a browser default scrollbar.
- **Sounds only for achievements** (onboarding finished, tour finished, a connection succeeded). Never for clicks, hovers or navigation.
- **Motion** uses `SPRINGS` from `@/lib/motion`; `prefers-reduced-motion` turns movement into cross-fades. No fixed-duration easing for anything interactive.
- **Copy rules:** plain language, sentence case, no jargon ("Two-step sign-in", not "MFA"). Module names appear **bold** in tour copy.
- **Accessibility:** every new route passes axe in both themes, every action has a keyboard path, focus is visible and trapped correctly in dialogs, and every input has a real label.
- Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Map

| Path | Responsibility |
|---|---|
| `packages/core/src/users/preferences.ts` | preference shape, defaults, Zod schemas, merge |
| `packages/core/src/onboarding/steps.ts` | the ordered onboarding steps and who gets which |
| `packages/core/src/tour/steps.ts` | the tour steps, version, bold-text parser |
| `packages/db/migrations/0011_user_onboarding.sql` | `users.preferences / onboarding / tour` |
| `apps/api/src/capabilities.ts` | which integrations exist yet (sheets, calendar) |
| `apps/api/src/modules/me/service.ts` (modify) | preferences merge, onboarding state, tour state |
| `apps/api/src/modules/me/routes.ts` (modify) | `PATCH /me` (preferences), `PUT /me/onboarding`, `PUT /me/tour` |
| `apps/api/src/modules/auth/routes.ts` (modify) | `/auth/me` returns preferences, onboarding, tour, capabilities, flags |
| `apps/api/src/auth/setup-token.ts` (modify) | mint the first-run token on demand, not only at boot |
| `apps/web/src/server/api.ts` | server-side fetch to the API with cookie forwarding |
| `apps/web/src/server/session.ts` | `getSession()`, `requireSession()`, `requirePermission()` |
| `apps/web/src/lib/api.ts` | browser fetch: CSRF, Idempotency-Key, typed result |
| `apps/web/src/lib/auth-client.ts` (modify) | sign-in, 2FA, recovery, forgot, reset, invite, setup calls |
| `apps/web/src/components/ui/{Field,ErrorState,Callout}.tsx` | shared form field, error state, inline callout |
| `apps/web/src/app/(auth)/…` | sign-in, 2FA, recovery, forgot, reset, invite pages |
| `apps/web/src/app/setup/…` | first-run wizard |
| `apps/web/src/app/welcome/…` | onboarding (the approved glass sheet) |
| `apps/web/src/components/onboarding/*` | rail, panels, connect cards |
| `apps/web/src/components/tour/*` | spotlight veil, card, provider |
| `apps/web/e2e/*` | full-stack Playwright: edge proxy, SMTP sink, flows, axe, visual, role snapshots |

---

### Task 1: API and core — preferences, onboarding state, tour state, capabilities

**Files:**
- Create: `packages/core/src/users/preferences.ts`, `packages/core/src/onboarding/steps.ts`, `packages/core/src/tour/steps.ts`, `packages/core/src/users/users.test.ts`
- Create: `packages/db/migrations/0011_user_onboarding.sql`
- Create: `apps/api/src/capabilities.ts`
- Modify: `packages/core/src/index.ts`, `packages/db/src/schema/identity.ts`, `apps/api/src/modules/me/{service,routes}.ts`, `apps/api/src/modules/me/me.test.ts`, `apps/api/src/modules/auth/routes.ts`, `apps/api/src/modules/auth/login.test.ts`, `apps/api/src/auth/setup-token.ts`, `apps/api/src/app.ts`, `apps/api/test/probes.ts`

**Interfaces:**
- Produces (core):
  - `type Preferences = { workingDays: number[]; workStart: string; workEnd: string; digestTime: string; sounds: { enabled: boolean; volume: number }; alerts: { assigned: boolean; dueFollowUps: boolean; emailDigest: boolean } }`
  - `PREFERENCES_DEFAULTS: Preferences`, `preferencesPatchSchema` (Zod, deep-partial, strict), `mergePreferences(current: unknown, patch: unknown): Preferences`
  - `type OnboardingStepId = "welcome" | "you" | "secure" | "look" | "day" | "alerts" | "team" | "pipeline" | "connect" | "done"`
  - `type OnboardingStep = { id: OnboardingStepId; title: string; group: "intro" | "you" | "workspace" | "end"; required: boolean; permission: PermissionKey | null; needsEnrolment?: true; needsCapability?: "sheets" | "calendar" }`
  - `ONBOARDING_STEPS: readonly OnboardingStep[]`, `onboardingStepsFor(ctx: OnboardingContext): OnboardingStep[]`, `type OnboardingContext = { actor: Actor; twoFactorEnabled: boolean; capabilities: Capabilities }`, `type Capabilities = { sheets: boolean; calendar: boolean }`
  - `type OnboardingState = { step: OnboardingStepId | null; skipped: OnboardingStepId[]; completedAt: string | null }`, `EMPTY_ONBOARDING`, `needsOnboarding(state: OnboardingState): boolean`
  - `TOUR_VERSION = 1`, `type TourStep = { id: string; target: string; title: string; body: string; placement: "right" | "bottom"; permission: PermissionKey | null; ownerOrAdmin?: true }`, `TOUR_STEPS`, `tourStepsFor(actor: Actor, caps: Capabilities): TourStep[]`, `type TourState = { version: number; step: number; completedAt: string | null; skippedAt: string | null }`, `EMPTY_TOUR`, `needsTour(state: TourState): boolean`, `boldParts(body: string): Array<{ text: string; bold: boolean }>`
- Produces (API): `CAPABILITIES: Capabilities`; `GET /api/v1/auth/me` gains `preferences`, `onboarding`, `tour`, `capabilities`, `flags: { needsOnboarding, needsTwoFactorEnrolment, needsTour }`; `PATCH /api/v1/me` accepts `preferences`; `PUT /api/v1/me/onboarding` `{ step?, skip?, completed? }` → `{ onboarding }`; `PUT /api/v1/me/tour` `{ step?, completed?, skipped? }` → `{ tour }`; `SetupTokens.ensure(): string | null`

- [ ] **Step 1: Write the failing core tests**

`packages/core/src/users/users.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { effectivePermissions, type Actor } from "../rbac/engine";
import { EMPTY_ONBOARDING, needsOnboarding, onboardingStepsFor } from "../onboarding/steps";
import { PREFERENCES_DEFAULTS, mergePreferences, preferencesPatchSchema } from "./preferences";
import { EMPTY_TOUR, TOUR_VERSION, boldParts, needsTour, tourStepsFor } from "../tour/steps";

const actor = (grants: Parameters<typeof effectivePermissions>[0], extra: Partial<Actor> = {}): Actor => ({
  userId: "u1",
  isOwner: false,
  perms: effectivePermissions(grants),
  teamMemberIds: [],
  twoFactorEnabled: true,
  roleIds: [],
  ...extra,
});
const NONE = { sheets: false, calendar: false };
const ALL = { sheets: true, calendar: true };

describe("preferences", () => {
  it("defaults to a Monday–Friday day with sounds on", () => {
    expect(PREFERENCES_DEFAULTS).toEqual({
      workingDays: [1, 2, 3, 4, 5],
      workStart: "09:00",
      workEnd: "18:00",
      digestTime: "08:00",
      sounds: { enabled: true, volume: 60 },
      alerts: { assigned: true, dueFollowUps: true, emailDigest: true },
    });
  });

  it("merges a patch onto what is stored, keeping untouched values", () => {
    const stored = { ...PREFERENCES_DEFAULTS, digestTime: "07:30" };
    const merged = mergePreferences(stored, { sounds: { volume: 20 }, workingDays: [1, 3, 5] });
    expect(merged.digestTime).toBe("07:30");
    expect(merged.workingDays).toEqual([1, 3, 5]);
    expect(merged.sounds).toEqual({ enabled: true, volume: 20 });
  });

  it("repairs anything unusable that is already stored", () => {
    expect(mergePreferences({ workStart: "nope", sounds: "loud" }, {})).toEqual(PREFERENCES_DEFAULTS);
  });

  it("rejects impossible values and unknown keys", () => {
    expect(preferencesPatchSchema.safeParse({ workStart: "9am" }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ workingDays: [7] }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ sounds: { volume: 120 } }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ digestTime: "08:00" }).success).toBe(true);
  });
});

describe("onboarding steps (spec §4.1)", () => {
  it("a sales rep gets the personal steps only, in order", () => {
    const steps = onboardingStepsFor({
      actor: actor([{ key: "leads.view", scope: "own" }]),
      twoFactorEnabled: false,
      capabilities: NONE,
    });
    expect(steps.map((s) => s.id)).toEqual(["welcome", "you", "look", "day", "alerts", "done"]);
  });

  it("asks an admin for their name before the required two-step step", () => {
    const steps = onboardingStepsFor({
      actor: actor([{ key: "users.manage", scope: null }]),
      twoFactorEnabled: false,
      capabilities: NONE,
    });
    expect(steps.map((s) => s.id).slice(0, 3)).toEqual(["welcome", "you", "secure"]);
    expect(steps.find((s) => s.id === "secure")!.required).toBe(true);
    expect(steps.every((s) => s.id === "secure" || !s.required)).toBe(true);
  });

  it("drops the two-step step once enrolled", () => {
    const steps = onboardingStepsFor({
      actor: actor([{ key: "users.manage", scope: null }]),
      twoFactorEnabled: true,
      capabilities: NONE,
    });
    expect(steps.map((s) => s.id)).not.toContain("secure");
  });

  it("adds workspace steps for the people who can do them", () => {
    const steps = onboardingStepsFor({
      actor: actor([
        { key: "users.manage", scope: null },
        { key: "pipelines.manage", scope: null },
        { key: "leads.import", scope: null },
      ]),
      twoFactorEnabled: true,
      capabilities: ALL,
    });
    expect(steps.map((s) => s.id)).toEqual(["welcome", "you", "look", "day", "alerts", "team", "pipeline", "connect", "done"]);
  });

  it("hides Connect until an integration exists", () => {
    const ctx = { actor: actor([{ key: "calendar.connect", scope: null }]), twoFactorEnabled: true, capabilities: NONE };
    expect(onboardingStepsFor(ctx).map((s) => s.id)).not.toContain("connect");
    expect(onboardingStepsFor({ ...ctx, capabilities: { sheets: false, calendar: true } }).map((s) => s.id)).toContain("connect");
  });

  it("is needed until it is completed", () => {
    expect(needsOnboarding(EMPTY_ONBOARDING)).toBe(true);
    expect(needsOnboarding({ step: "look", skipped: [], completedAt: null })).toBe(true);
    expect(needsOnboarding({ step: null, skipped: ["day"], completedAt: "2026-09-24T09:00:00Z" })).toBe(false);
  });
});

describe("tour steps (spec §5)", () => {
  const rep = actor([
    { key: "leads.view", scope: "own" },
    { key: "templates.use", scope: null },
    { key: "calendar.view", scope: "own" },
    { key: "analytics.view", scope: "own" },
  ]);
  const admin = actor([{ key: "users.manage", scope: null }, { key: "audit.view", scope: null }], { isOwner: true });

  it("every step names a target and a real permission, and starts with LUME itself", () => {
    expect(TOUR_STEPS[0]!.id).toBe("lume");
    for (const s of TOUR_STEPS) expect(s.target).toMatch(/^[a-z][a-z-]*$/);
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
  });

  it("shows a rep only what they can open, and admins get the extra places", () => {
    const repIds = tourStepsFor(rep, ALL).map((s) => s.id);
    const adminIds = tourStepsFor(admin, ALL).map((s) => s.id);
    expect(repIds).toContain("reveal");
    expect(repIds).not.toContain("people");
    expect(repIds).not.toContain("audit");
    expect(adminIds).toContain("people");
    expect(adminIds).toContain("audit");
    expect(adminIds.length).toBeGreaterThan(repIds.length);
  });

  it("leaves out steps for parts that do not exist yet", () => {
    expect(tourStepsFor(rep, NONE).map((s) => s.id)).not.toContain("calendar");
  });

  it("is needed until finished or skipped, and again after a new version", () => {
    expect(needsTour(EMPTY_TOUR)).toBe(true);
    expect(needsTour({ version: TOUR_VERSION, step: 3, completedAt: null, skippedAt: null })).toBe(true);
    expect(needsTour({ version: TOUR_VERSION, step: 9, completedAt: "now", skippedAt: null })).toBe(false);
    expect(needsTour({ version: TOUR_VERSION, step: 2, completedAt: null, skippedAt: "now" })).toBe(false);
    expect(needsTour({ version: TOUR_VERSION - 1, step: 9, completedAt: "now", skippedAt: null })).toBe(true);
  });

  it("marks module names bold without any HTML", () => {
    expect(boldParts("Press **Ctrl K** to search")).toEqual([
      { text: "Press ", bold: false },
      { text: "Ctrl K", bold: true },
      { text: " to search", bold: false },
    ]);
    expect(boldParts("<b>nope</b>")).toEqual([{ text: "<b>nope</b>", bold: false }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run packages/core/src/users`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the core modules**

`packages/core/src/users/preferences.ts`:
```ts
import { z } from "zod";

/** What LUME remembers about how one person works (spec §4.2). Stored on users.preferences. */
export type Preferences = {
  /** 0 = Sunday … 6 = Saturday. */
  workingDays: number[];
  workStart: string;
  workEnd: string;
  digestTime: string;
  sounds: { enabled: boolean; volume: number };
  alerts: { assigned: boolean; dueFollowUps: boolean; emailDigest: boolean };
};

export const PREFERENCES_DEFAULTS: Preferences = {
  workingDays: [1, 2, 3, 4, 5],
  workStart: "09:00",
  workEnd: "18:00",
  digestTime: "08:00",
  sounds: { enabled: true, volume: 60 },
  alerts: { assigned: true, dueFollowUps: true, emailDigest: true },
};

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const full = z.strictObject({
  workingDays: z.array(z.number().int().min(0).max(6)).max(7),
  workStart: time,
  workEnd: time,
  digestTime: time,
  sounds: z.strictObject({ enabled: z.boolean(), volume: z.number().int().min(0).max(100) }),
  alerts: z.strictObject({ assigned: z.boolean(), dueFollowUps: z.boolean(), emailDigest: z.boolean() }),
});

/** A patch may set any subset, one level deep inside `sounds` and `alerts`. */
export const preferencesPatchSchema = z.strictObject({
  workingDays: full.shape.workingDays.optional(),
  workStart: time.optional(),
  workEnd: time.optional(),
  digestTime: time.optional(),
  sounds: full.shape.sounds.partial().optional(),
  alerts: full.shape.alerts.partial().optional(),
});
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

/**
 * Merge a patch onto what is stored. Anything stored that no longer parses (an older shape, a hand-edited
 * row) falls back to the default for that value rather than failing the request.
 */
export function mergePreferences(stored: unknown, patch: unknown): Preferences {
  const base = full.safeParse(stored);
  const current: Preferences = base.success
    ? base.data
    : {
        ...PREFERENCES_DEFAULTS,
        ...repair(stored),
      };
  const p = preferencesPatchSchema.parse(patch ?? {});
  return {
    workingDays: p.workingDays ?? current.workingDays,
    workStart: p.workStart ?? current.workStart,
    workEnd: p.workEnd ?? current.workEnd,
    digestTime: p.digestTime ?? current.digestTime,
    sounds: { ...current.sounds, ...(p.sounds ?? {}) },
    alerts: { ...current.alerts, ...(p.alerts ?? {}) },
  };
}

/** Keep whichever individual values still parse; drop the rest. */
function repair(stored: unknown): Partial<Preferences> {
  if (typeof stored !== "object" || stored === null) return {};
  const out: Partial<Preferences> = {};
  const src = stored as Record<string, unknown>;
  for (const key of ["workingDays", "workStart", "workEnd", "digestTime", "sounds", "alerts"] as const) {
    const field = full.shape[key];
    const r = field.safeParse(src[key]);
    if (r.success) Object.assign(out, { [key]: r.data });
  }
  return out;
}
```

`packages/core/src/onboarding/steps.ts`:
```ts
import type { PermissionKey } from "../rbac/catalog";
import { can, requiresTwoFactor, type Actor } from "../rbac/engine";

/** Which integrations this build actually has (the API owns the values; see apps/api/src/capabilities.ts). */
export type Capabilities = { sheets: boolean; calendar: boolean };

export type OnboardingStepId =
  | "welcome"
  | "you"
  | "secure"
  | "look"
  | "day"
  | "alerts"
  | "team"
  | "pipeline"
  | "connect"
  | "done";

export type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  group: "intro" | "you" | "workspace" | "end";
  /** A required step cannot be skipped and blocks the ones after it. */
  required: boolean;
  permission: PermissionKey | null;
  /** Only for people whose roles require two-step sign-in and who haven't enrolled. */
  needsEnrolment?: true;
  /** Only when that integration exists in this build. */
  needsCapability?: "sheets" | "calendar";
};

/**
 * Spec §4.1. Name first, then the required two-step enrolment for admins, then the rest. Order is fixed
 * here so the API and the web app show exactly the same flow.
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { id: "welcome", title: "Welcome", group: "intro", required: false, permission: null },
  { id: "you", title: "You", group: "you", required: false, permission: null },
  { id: "secure", title: "Secure account", group: "you", required: true, permission: null, needsEnrolment: true },
  { id: "look", title: "Look", group: "you", required: false, permission: null },
  { id: "day", title: "Your day", group: "you", required: false, permission: null },
  { id: "alerts", title: "Alerts", group: "you", required: false, permission: null },
  { id: "team", title: "Your team", group: "workspace", required: false, permission: "users.manage" },
  { id: "pipeline", title: "Pipeline", group: "workspace", required: false, permission: "pipelines.manage" },
  { id: "connect", title: "Connect", group: "workspace", required: false, permission: null },
  { id: "done", title: "All set", group: "end", required: false, permission: null },
];

export type OnboardingContext = { actor: Actor; twoFactorEnabled: boolean; capabilities: Capabilities };

export function onboardingStepsFor({ actor, twoFactorEnabled, capabilities }: OnboardingContext): OnboardingStep[] {
  const hasConnect =
    (capabilities.calendar && (actor.isOwner || can(actor, "calendar.connect"))) ||
    (capabilities.sheets && (actor.isOwner || can(actor, "leads.import")));
  return ONBOARDING_STEPS.filter((s) => {
    if (s.needsEnrolment) return requiresTwoFactor(actor) && !twoFactorEnabled;
    if (s.id === "connect") return hasConnect;
    return s.permission === null || can(actor, s.permission);
  });
}

export type OnboardingState = { step: OnboardingStepId | null; skipped: OnboardingStepId[]; completedAt: string | null };
export const EMPTY_ONBOARDING: OnboardingState = { step: null, skipped: [], completedAt: null };
export const needsOnboarding = (state: OnboardingState): boolean => state.completedAt === null;
```

`packages/core/src/tour/steps.ts`:
```ts
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
  { id: "lume", target: "brand", title: "This is LUME", body: "Every lead, follow-up and call in one place. You move around from this sidebar.", placement: "right", permission: null },
  { id: "today", target: "nav-today", title: "Start on Today", body: "**Today** is your list: follow-ups due, new replies and calls booked. Nothing else.", placement: "right", permission: null },
  { id: "leads", target: "nav-leads", title: "Leads is the full list", body: "**Leads** holds everyone you own. Filter, sort, edit in place, or pick many at once.", placement: "right", permission: "leads.view" },
  { id: "pipeline", target: "nav-pipeline", title: "Pipeline is the board", body: "**Pipeline** shows your stages side by side. Drag a lead to move it along.", placement: "right", permission: "leads.view" },
  { id: "reveal", target: "nav-leads", title: "Contacts stay hidden", body: "Numbers and emails are masked. **Reveal** shows one lead’s details, and records that you looked.", placement: "right", permission: "leads.contact.reveal" },
  { id: "calendar", target: "nav-calendar", title: "Calendar shows lead calls", body: "**Calendar** pulls your Google Calendar and shows only meetings with leads.", placement: "right", permission: "calendar.view", needsCapability: "calendar" },
  { id: "templates", target: "nav-templates", title: "Templates write for you", body: "**Templates** are approved messages with the lead’s details filled in automatically.", placement: "right", permission: "templates.use" },
  { id: "analytics", target: "nav-analytics", title: "Analytics shows what works", body: "**Analytics** answers where leads come from, where they stall and what you won.", placement: "right", permission: "analytics.view" },
  { id: "search", target: "search", title: "Jump anywhere", body: "Press **Ctrl K** to find a lead by name or run an action, from any screen.", placement: "bottom", permission: null },
  { id: "notifications", target: "notifications", title: "Reminders land here", body: "The bell holds your reminders and new replies. Act on them without leaving the page.", placement: "bottom", permission: null },
  { id: "people", target: "nav-settings", title: "People and roles", body: "In **Settings**, invite people and choose what each role may see. Sales see only their own leads.", placement: "right", permission: "users.manage" },
  { id: "audit", target: "nav-settings", title: "Audit log", body: "**Settings** also holds the audit log: every sign-in, reveal and change, and nobody can edit it.", placement: "right", permission: "audit.view" },
  { id: "settings", target: "nav-settings", title: "Settings is yours too", body: "**Settings** keeps your timezone, theme, alerts and this tour. Change them any time.", placement: "right", permission: null },
  { id: "me", target: "profile", title: "That’s LUME", body: "Your profile, theme and sign-out live here. Replay this tour any time from **Settings**.", placement: "right", permission: null },
];

export function tourStepsFor(actor: Actor, capabilities: Capabilities): TourStep[] {
  return TOUR_STEPS.filter((s) => {
    if (s.needsCapability && !capabilities[s.needsCapability]) return false;
    return s.permission === null || can(actor, s.permission);
  });
}

export type TourState = { version: number; step: number; completedAt: string | null; skippedAt: string | null };
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
```

Append to `packages/core/src/index.ts`:
```ts
export * from "./users/preferences";
export * from "./onboarding/steps";
export * from "./tour/steps";
```

- [ ] **Step 4: Run to verify the core tests pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/core && pnpm --filter @lume/core typecheck'`
Expected: all pass (19 new).

- [ ] **Step 5: Migration and Drizzle mirror**

`packages/db/migrations/0011_user_onboarding.sql`:
```sql
-- Per-person preferences and the state of their first-run onboarding and product tour (spec §4.2).
ALTER TABLE users
  ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN onboarding  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN tour        jsonb NOT NULL DEFAULT '{}'::jsonb;
```

In `packages/db/src/schema/identity.ts`, add to the `users` table (after `theme`):
```ts
  preferences: jsonb("preferences").$type<import("@lume/core").Preferences | Record<string, never>>().notNull().default(sql`'{}'::jsonb`),
  onboarding: jsonb("onboarding").$type<Partial<import("@lume/core").OnboardingState>>().notNull().default(sql`'{}'::jsonb`),
  tour: jsonb("tour").$type<Partial<import("@lume/core").TourState>>().notNull().default(sql`'{}'::jsonb`),
```

- [ ] **Step 6: Write the failing API tests**

Append to `apps/api/src/modules/me/me.test.ts`:
```ts
describe("preferences, onboarding and tour state (spec §4.2)", () => {
  it("starts with defaults, merges a patch, and keeps the rest", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    const me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.preferences).toEqual(PREFERENCES_DEFAULTS);
    expect(me.flags).toEqual({ needsOnboarding: true, needsTwoFactorEnrolment: false, needsTour: true });
    const r = await c.inject({
      method: "PATCH",
      url: "/api/v1/me",
      payload: { timezone: "Asia/Kolkata", preferences: { digestTime: "07:15", sounds: { volume: 10 } } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().preferences).toMatchObject({ digestTime: "07:15", sounds: { enabled: true, volume: 10 } });
    const again = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(again.preferences.workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(again.preferences.digestTime).toBe("07:15");
  });

  it("refuses nonsense preferences", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    const r = await c.inject({ method: "PATCH", url: "/api/v1/me", payload: { preferences: { workStart: "9am" } } });
    expect(r.statusCode).toBe(400);
  });

  it("remembers where onboarding got to, what was skipped, and when it finished", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    let r = await c.inject({ method: "PUT", url: "/api/v1/me/onboarding", payload: { step: "day", skip: "look" } });
    expect(r.json().onboarding).toMatchObject({ step: "day", skipped: ["look"], completedAt: null });
    r = await c.inject({ method: "PUT", url: "/api/v1/me/onboarding", payload: { skip: "look" } });
    expect(r.json().onboarding.skipped).toEqual(["look"]); // recorded once
    r = await c.inject({ method: "PUT", url: "/api/v1/me/onboarding", payload: { completed: true } });
    expect(r.json().onboarding.completedAt).not.toBeNull();
    const me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.flags.needsOnboarding).toBe(false);
    expect((await h.pool.query("SELECT count(*)::int n FROM audit_log WHERE action = 'user.onboarding.completed'")).rows[0].n).toBe(1);
  });

  it("tracks tour progress and stops asking once finished", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    await c.inject({ method: "PUT", url: "/api/v1/me/tour", payload: { step: 4 } });
    let me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.tour).toMatchObject({ version: TOUR_VERSION, step: 4, completedAt: null });
    expect(me.flags.needsTour).toBe(true);
    await c.inject({ method: "PUT", url: "/api/v1/me/tour", payload: { completed: true } });
    me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.flags.needsTour).toBe(false);
    expect(me.tour.completedAt).not.toBeNull();
  });

  it("tells the app which integrations exist", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    expect((await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json().capabilities).toEqual({
      sheets: false,
      calendar: false,
    });
  });

  it("flags an admin who still has to enrol in two-step sign-in", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [{ key: "users.manage", scope: null }] }));
    const me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.flags).toMatchObject({ needsTwoFactorEnrolment: true, needsOnboarding: true });
  });
});
```
Add to that file's imports: `import { PREFERENCES_DEFAULTS, TOUR_VERSION } from "@lume/core";`.

Append to `apps/api/src/modules/setup/setup.test.ts`:
```ts
describe("the first-run token when the database is wiped", () => {
  it("is minted on demand while there are no users, and logged again", async () => {
    const fresh = await createHarness({ noSettings: true, forgetSetupToken: true });
    try {
      const status = await fresh.app.inject({ method: "GET", url: "/api/v1/setup/status" });
      expect(status.json().needsSetup).toBe(true);
      expect(fresh.mintedTokens.length).toBe(1); // printed for the operator
    } finally {
      await fresh.close();
    }
  });
});
```
Harness additions for that test: `createHarness({ forgetSetupToken })` starts with `current()` returning null and records every token that `ensure()` mints in `mintedTokens: string[]`.

- [ ] **Step 7: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/api/src/modules/me apps/api/src/modules/setup`
Expected: FAIL (no `preferences` in the response; `PUT /me/onboarding` 404).

- [ ] **Step 8: Implement the API side**

`apps/api/src/capabilities.ts`:
```ts
import type { Capabilities } from "@lume/core";

/**
 * Which integrations this build actually has. The onboarding Connect step and the tour's Calendar step
 * appear only when the matching one is true, so no screen ever offers something that isn't there.
 * Flipped to true by the phases that build them (Sheets intake, then Google Calendar connect).
 */
export const CAPABILITIES: Capabilities = { sheets: false, calendar: false };
```

Add to `apps/api/src/modules/me/service.ts`:
```ts
import { EMPTY_ONBOARDING, EMPTY_TOUR, TOUR_VERSION, mergePreferences, type OnboardingState, type TourState } from "@lume/core";

export const onboardingOf = (row: { onboarding: Partial<OnboardingState> }): OnboardingState => ({
  ...EMPTY_ONBOARDING,
  ...row.onboarding,
});
export const tourOf = (row: { tour: Partial<TourState> }): TourState => ({ ...EMPTY_TOUR, ...row.tour });

export async function updateOnboarding(
  req: FastifyRequest,
  patch: { step?: OnboardingState["step"]; skip?: NonNullable<OnboardingState["step"]>; completed?: boolean },
) {
  const userId = req.actor!.userId;
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, userId)).for("update");
  const state = onboardingOf(u!);
  const next: OnboardingState = {
    step: patch.step ?? state.step,
    skipped: patch.skip && !state.skipped.includes(patch.skip) ? [...state.skipped, patch.skip] : state.skipped,
    completedAt: patch.completed ? (state.completedAt ?? new Date().toISOString()) : state.completedAt,
  };
  await req.db.update(schema.users).set({ onboarding: next }).where(eq(schema.users.id, userId));
  if (patch.completed && !state.completedAt) {
    await audit(req, {
      action: "user.onboarding.completed",
      entityType: "user",
      entityId: userId,
      diff: { skipped: next.skipped },
    });
  }
  return { onboarding: next };
}

export async function updateTour(req: FastifyRequest, patch: { step?: number; completed?: boolean; skipped?: boolean }) {
  const userId = req.actor!.userId;
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, userId)).for("update");
  const state = tourOf(u!);
  const now = new Date().toISOString();
  const fresh = state.version === TOUR_VERSION ? state : EMPTY_TOUR;
  const next: TourState = {
    version: TOUR_VERSION,
    step: patch.step ?? fresh.step,
    completedAt: patch.completed ? (fresh.completedAt ?? now) : fresh.completedAt,
    skippedAt: patch.skipped ? (fresh.skippedAt ?? now) : fresh.skippedAt,
  };
  await req.db.update(schema.users).set({ tour: next }).where(eq(schema.users.id, userId));
  return { tour: next };
}
```
Extend `updateProfile` in the same file so a `preferences` patch is merged:
```ts
export type ProfilePatch = {
  name?: string;
  timezone?: string;
  theme?: "system" | "porcelain" | "obsidian";
  preferences?: unknown;
};

export async function updateProfile(req: FastifyRequest, patch: ProfilePatch) {
  const where = eq(schema.users.id, req.actor!.userId);
  const { preferences, ...columns } = patch;
  const set: Record<string, unknown> = { ...columns };
  if (preferences !== undefined) {
    const [current] = await req.db.select({ preferences: schema.users.preferences }).from(schema.users).where(where);
    set.preferences = mergePreferences(current?.preferences, preferences);
  }
  const [u] = Object.keys(set).length
    ? await req.db.update(schema.users).set(set).where(where).returning()
    : await req.db.select().from(schema.users).where(where);
  await audit(req, { action: "user.profile.updated", entityType: "user", entityId: u!.id, diff: { fields: Object.keys(set) } });
  return {
    id: u!.id,
    name: u!.name,
    email: u!.email,
    timezone: u!.timezone,
    theme: u!.theme,
    preferences: mergePreferences(u!.preferences, {}),
  };
}
```

In `apps/api/src/modules/me/routes.ts`, extend the `PATCH /me` body with `preferences: preferencesPatchSchema.optional()` and add:
```ts
  r.put(
    "/api/v1/me/onboarding",
    {
      config: enrol,
      schema: {
        body: z
          .object({
            step: z.enum(ONBOARDING_STEP_IDS).nullable().optional(),
            skip: z.enum(ONBOARDING_STEP_IDS).optional(),
            completed: z.literal(true).optional(),
          })
          .strict(),
      },
    },
    (req) => me.updateOnboarding(req, req.body),
  );
  r.put(
    "/api/v1/me/tour",
    {
      config: self,
      schema: {
        body: z
          .object({
            step: z.number().int().min(0).max(100).optional(),
            completed: z.literal(true).optional(),
            skipped: z.literal(true).optional(),
          })
          .strict(),
      },
    },
    (req) => me.updateTour(req, req.body),
  );
```
with `const ONBOARDING_STEP_IDS = ONBOARDING_STEPS.map((s) => s.id) as [OnboardingStepId, ...OnboardingStepId[]];` above (imported from `@lume/core`). `PUT /me/onboarding` uses `enrol` (reachable while the required two-step step is outstanding); `PUT /me/tour` uses `self`.

In `apps/api/src/modules/auth/routes.ts`, extend `GET /auth/me`:
```ts
    const onboarding = onboardingOf(u);
    const tour = tourOf(u);
    const needsEnrolment = requiresTwoFactor(a) && !a.twoFactorEnabled;
    return {
      user: { id: u.id, name: u.name, email: u.email, isOwner: u.isOwner, theme: u.theme, timezone: u.timezone },
      permissions: [...a.perms.entries()]
        .map(([key, scope]) => ({ key, scope: scope === true ? null : scope }))
        .sort((x, y) => x.key.localeCompare(y.key)),
      twoFactor: { enabled: a.twoFactorEnabled, required: requiresTwoFactor(a) },
      preferences: mergePreferences(u.preferences, {}),
      onboarding,
      tour,
      capabilities: CAPABILITIES,
      flags: {
        needsOnboarding: needsOnboarding(onboarding),
        needsTwoFactorEnrolment: needsEnrolment,
        needsTour: !needsOnboarding(onboarding) && needsTour(tour),
      },
    };
```

`apps/api/src/auth/setup-token.ts` — mint on demand as well as at boot:
```ts
import { randomToken } from "@lume/core";

/**
 * The one-time first-run token (report §15.3). Printed for the operator while the installation has no
 * users at all — at boot, and again on demand if a wiped database is asked for its setup status, so an
 * operator who resets an installation is never locked out of setting it up again.
 */
export type SetupTokens = { current(): string | null; ensure(): string; burn(): void };

export function processSetupTokens(needsSetup: boolean, log: (msg: string) => void): SetupTokens {
  let token: string | null = null;
  const mint = () => {
    token = randomToken(24);
    log(`LUME first-run setup token: ${token} (open /setup and paste it; valid until the owner account exists)`);
    return token;
  };
  if (needsSetup) mint();
  return { current: () => token, ensure: () => token ?? mint(), burn: () => void (token = null) };
}
```
In `apps/api/src/modules/setup/routes.ts`, `GET /setup/status` becomes:
```ts
  r.get("/api/v1/setup/status", { config: { public: true } }, async () => {
    const { rows } = await d.pool.query<{ has_users: boolean }>("SELECT EXISTS (SELECT 1 FROM users) AS has_users");
    if (rows[0]!.has_users) return { needsSetup: false };
    d.setupTokens.ensure(); // a wiped installation can still be set up; the token is printed again
    return { needsSetup: true };
  });
```

- [ ] **Step 9: Update the harness and probes**

In `apps/api/test/harness.ts`: add `forgetSetupToken?: boolean` to the options, `mintedTokens: string[]` to `Harness`, and build the tokens as
```ts
  const mintedTokens: string[] = [];
  let token: string | null = opts.forgetSetupToken ? null : SETUP_TOKEN;
  const setupTokens: SetupTokens = {
    current: () => token,
    ensure: () => {
      if (!token) {
        token = `test-minted-${randomToken(8)}`;
        mintedTokens.push(token);
      }
      return token;
    },
    burn: () => void (token = null),
  };
```
In `apps/api/test/probes.ts` add:
```ts
  "PUT /api/v1/me/onboarding": { access: "auth.self", body: () => ({ step: "look" }) },
  "PUT /api/v1/me/tour": { access: "auth.self", body: () => ({ step: 1 }) },
```

- [ ] **Step 10: Run the strict gate**

Run: `scripts/dev.sh fmt` then the strict gate (`pnpm lint && pnpm typecheck && pnpm test`, non-zero on failure).
Expected: green. The drift test now covers the three new columns; `schema.test.ts`'s migration count comes from the directory, so it needs no edit.

- [ ] **Step 11: Commit and push**

```bash
git add -A && git commit -m "feat(api): per-person preferences, onboarding and tour state, capability flags, on-demand setup token

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 2: Web — real sessions, permissions and API access

**Files:**
- Create: `apps/web/src/server/api.ts`, `apps/web/src/server/session.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/api.test.ts`, `apps/web/src/server/session.test.ts`, `apps/web/src/components/ui/ErrorState.tsx`, `apps/web/src/components/ui/ErrorState.module.css`
- Modify: `apps/web/src/app/(app)/layout.tsx`, `apps/web/src/proxy.ts`, `apps/web/src/components/shell/{AppShell,Sidebar,TopBar}.tsx`, `apps/web/src/components/shell/nav.ts`, `infra/docker-compose.yml`, `infra/compose.dev.yml`

**Interfaces:**
- Consumes: `GET /api/v1/auth/me`, `GET /api/v1/settings` (both from 1A/1B).
- Produces:
  - `apiGet<T>(path: string, init?: { cookie?: string }): Promise<{ status: number; data: T | null }>` (server only)
  - `type Session = { user: { id; name; email; isOwner; theme; timezone }; permissions: { key: PermissionKey; scope: Scope | null }[]; twoFactor: { enabled; required }; preferences: Preferences; onboarding: OnboardingState; tour: TourState; capabilities: Capabilities; flags: { needsOnboarding; needsTwoFactorEnrolment; needsTour }; actor: Actor }`
  - `getSession(): Promise<Session | null>` (memoised per request), `requireSession(): Promise<Session>` (redirects), `businessName(): Promise<string>`
  - browser: `api.post/patch/put/del<T>(path, body?): Promise<ApiResult<T>>`, where `ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; code: string; message: string; details?: unknown }`
  - `<ErrorState title message onRetry? />`
  - `AppShell` props change to `{ session: Session; businessName: string; theme: ThemePref; children }`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/api.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, resetCsrfForTests } from "./api";

const csrfResponse = () =>
  new Response(JSON.stringify({ token: "csrf-token-value" }), { status: 200, headers: { "content-type": "application/json" } });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("browser API client", () => {
  beforeEach(() => {
    resetCsrfForTests();
    vi.restoreAllMocks();
  });

  it("sends the CSRF token, an Idempotency-Key and same-origin credentials", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/auth/csrf") ? csrfResponse() : json(201, { lead: { id: "l1" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await api.post<{ lead: { id: string } }>("/api/v1/leads", { name: "Asha" });
    expect(r).toEqual({ ok: true, status: 201, data: { lead: { id: "l1" } } });
    const [, init] = fetchMock.mock.calls[1]!;
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("x-csrf-token")).toBe("csrf-token-value");
    expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect((init as RequestInit).credentials).toBe("same-origin");
  });

  it("fetches the CSRF token once and reuses it", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/auth/csrf") ? csrfResponse() : json(200, {}),
    );
    vi.stubGlobal("fetch", fetchMock);
    await api.post("/api/v1/a");
    await api.post("/api/v1/b");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/auth/csrf"))).toHaveLength(1);
  });

  it("returns the API's error code and message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith("/auth/csrf")
          ? csrfResponse()
          : json(409, { error: { code: "VERSION_CONFLICT", message: "Someone else changed this lead.", details: { currentVersion: 4 } } }),
      ),
    );
    const r = await api.patch("/api/v1/leads/x", { name: "n" });
    expect(r).toEqual({
      ok: false,
      status: 409,
      code: "VERSION_CONFLICT",
      message: "Someone else changed this lead.",
      details: { currentVersion: 4 },
    });
  });

  it("turns an unreachable API into a plain message, never a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    const r = await api.post("/api/v1/leads", {});
    expect(r).toMatchObject({ ok: false, status: 0, code: "OFFLINE" });
    expect(r.ok === false && r.message.length).toBeGreaterThan(10);
  });

  it("retries once with a fresh token when the CSRF cookie has expired", async () => {
    let csrfCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/auth/csrf")) {
        csrfCalls++;
        return csrfResponse();
      }
      return csrfCalls < 2 ? json(403, { error: { code: "CSRF", message: "no" } }) : json(200, { ok: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await api.post("/api/v1/x");
    expect(r.ok).toBe(true);
    expect(csrfCalls).toBe(2);
  });

  it("handles an empty 204 body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => (String(url).endsWith("/auth/csrf") ? csrfResponse() : new Response(null, { status: 204 }))),
    );
    const r = await api.del("/api/v1/me/sessions/abc");
    expect(r).toEqual({ ok: true, status: 204, data: null });
  });
});
```

`apps/web/src/server/session.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { toSession } from "./session";

const payload = {
  user: { id: "u1", name: "Riya", email: "r@x.com", isOwner: false, theme: "system", timezone: "Asia/Dubai" },
  permissions: [
    { key: "leads.view", scope: "team" },
    { key: "templates.use", scope: null },
  ],
  twoFactor: { enabled: false, required: false },
  preferences: { workingDays: [1], workStart: "09:00", workEnd: "18:00", digestTime: "08:00", sounds: { enabled: true, volume: 60 }, alerts: { assigned: true, dueFollowUps: true, emailDigest: true } },
  onboarding: { step: null, skipped: [], completedAt: null },
  tour: { version: 0, step: 0, completedAt: null, skippedAt: null },
  capabilities: { sheets: false, calendar: false },
  flags: { needsOnboarding: true, needsTwoFactorEnrolment: false, needsTour: true },
};

describe("session", () => {
  it("builds an actor whose scopes match what the API sent", () => {
    const s = toSession(payload);
    expect(s.actor.perms.get("leads.view")).toBe("team");
    expect(s.actor.perms.get("templates.use")).toBe(true);
    expect(s.actor.isOwner).toBe(false);
    expect(s.actor.twoFactorEnabled).toBe(false);
  });

  it("ignores permission keys it doesn't know (a newer API)", () => {
    const s = toSession({ ...payload, permissions: [...payload.permissions, { key: "leads.timetravel", scope: "all" }] });
    expect([...s.actor.perms.keys()]).toEqual(["leads.view", "templates.use"]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/lib/api.test.ts apps/web/src/server`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the server helpers**

`apps/web/src/server/api.ts`:
```ts
import { cookies } from "next/headers";

/**
 * Server-side calls to the API (spec §3). Inside the compose network the API is reachable at
 * http://api:3001; the visitor's session cookie is forwarded so the API decides what they may see.
 * Never cached: every render reflects the current session and data.
 */
const BASE = process.env.LUME_API_URL ?? "http://api:3001";

export type ApiResponse<T> = { status: number; data: T | null };

export async function apiGet<T>(path: string): Promise<ApiResponse<T>> {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      // A page render must never hang on the API.
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
  } catch {
    return { status: 0, data: null };
  }
}
```

`apps/web/src/server/session.ts`:
```ts
import { cache } from "react";
import { redirect } from "next/navigation";
import {
  EMPTY_ONBOARDING,
  EMPTY_TOUR,
  PREFERENCES_DEFAULTS,
  can,
  effectivePermissions,
  isPermissionKey,
  type Actor,
  type Capabilities,
  type OnboardingState,
  type PermissionKey,
  type Preferences,
  type Scope,
  type TourState,
} from "@lume/core";
import { apiGet } from "./api";

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  isOwner: boolean;
  theme: "system" | "porcelain" | "obsidian";
  timezone: string | null;
};
export type Session = {
  user: SessionUser;
  permissions: { key: PermissionKey; scope: Scope | null }[];
  twoFactor: { enabled: boolean; required: boolean };
  preferences: Preferences;
  onboarding: OnboardingState;
  tour: TourState;
  capabilities: Capabilities;
  flags: { needsOnboarding: boolean; needsTwoFactorEnrolment: boolean; needsTour: boolean };
  /** The same Actor shape the API and core use, so gates call the very same `can()`. */
  actor: Actor;
};

type MePayload = Omit<Session, "actor"> & { permissions: { key: string; scope: Scope | null }[] };

export function toSession(me: MePayload): Session {
  const known = me.permissions.filter((p): p is { key: PermissionKey; scope: Scope | null } => isPermissionKey(p.key));
  return {
    user: me.user,
    permissions: known,
    twoFactor: me.twoFactor,
    preferences: me.preferences ?? PREFERENCES_DEFAULTS,
    onboarding: me.onboarding ?? EMPTY_ONBOARDING,
    tour: me.tour ?? EMPTY_TOUR,
    capabilities: me.capabilities,
    flags: me.flags,
    actor: {
      userId: me.user.id,
      isOwner: me.user.isOwner,
      perms: effectivePermissions(known.map((p) => ({ key: p.key, scope: p.scope }))),
      teamMemberIds: [],
      twoFactorEnabled: me.twoFactor.enabled,
      roleIds: [],
    },
  };
}

/** One call per render, whoever asks (React cache). */
export const getSession = cache(async (): Promise<Session | null> => {
  const { status, data } = await apiGet<MePayload>("/api/v1/auth/me");
  return status === 200 && data ? toSession(data) : null;
});

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/sign-in");
  return s;
}

/** Render-time convenience. The API refuses anyway; this only avoids showing a dead end. */
export async function requirePermission(key: PermissionKey): Promise<Session> {
  const s = await requireSession();
  if (!can(s.actor, key)) redirect("/today");
  return s;
}

export const businessName = cache(async (): Promise<string> => {
  const { data } = await apiGet<{ businessName: string }>("/api/v1/settings");
  return data?.businessName ?? "LUME";
});
```

`apps/web/src/lib/api.ts`:
```ts
"use client";

/**
 * Browser calls to the API (spec §3). Same-origin, with the CSRF double-submit header and an
 * Idempotency-Key so a double click or a retry can never create two of anything (report §4.4).
 */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string; details?: unknown };

const OFFLINE = "LUME can’t reach the server right now. Check your connection and try again.";
let csrf: string | null = null;

/** Tests only. */
export function resetCsrfForTests(): void {
  csrf = null;
}

async function csrfToken(force = false): Promise<string | null> {
  if (csrf && !force) return csrf;
  try {
    const res = await fetch("/api/v1/auth/csrf", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return null;
    csrf = ((await res.json()) as { token?: string }).token ?? null;
    return csrf;
  } catch {
    return null;
  }
}

async function send<T>(method: string, path: string, body?: unknown, retry = true): Promise<ApiResult<T>> {
  const token = await csrfToken();
  const headers: Record<string, string> = { "idempotency-key": crypto.randomUUID() };
  if (token) headers["x-csrf-token"] = token;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, code: "OFFLINE", message: OFFLINE };
  }
  const text = await res.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;
  if (res.ok) return { ok: true, status: res.status, data: payload as T };
  const err = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  // A stale CSRF cookie (a long-open tab) is worth exactly one silent retry.
  if (res.status === 403 && err?.code === "CSRF" && retry) {
    await csrfToken(true);
    return send<T>(method, path, body, false);
  }
  return {
    ok: false,
    status: res.status,
    code: err?.code ?? "UNKNOWN",
    message: err?.message ?? "Something went wrong. Try again.",
    ...(err?.details !== undefined ? { details: err.details } : {}),
  };
}

export const api = {
  post: <T>(path: string, body?: unknown) => send<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => send<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => send<T>("PUT", path, body),
  del: <T>(path: string) => send<T>("DELETE", path),
};
```

`apps/web/src/components/ui/ErrorState.tsx`:
```tsx
import { Button } from "./Button";
import s from "./ErrorState.module.css";

/** One way to show a failure: what happened, in plain words, and a way forward. */
export function ErrorState({
  title = "That didn’t work",
  message,
  action,
}: {
  title?: string;
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className={s.wrap} role="alert">
      <h2 className={s.title}>{title}</h2>
      <p className={s.message}>{message}</p>
      {action ? (
        <Button variant="secondary" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
```
```css
/* ErrorState.module.css */
.wrap {
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 48px 24px;
  text-align: center;
}
.title {
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.014em;
}
.message {
  color: var(--text-2);
  max-width: 42ch;
  line-height: 1.55;
}
```

- [ ] **Step 4: Wire the shell to the real session**

`apps/web/src/app/(app)/layout.tsx`:
```tsx
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { THEME_COOKIE, parseThemePref } from "@/lib/theme";
import { businessName, requireSession } from "@/server/session";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  // Onboarding (and any outstanding required two-step enrolment) comes before the app itself.
  if (session.flags.needsOnboarding || session.flags.needsTwoFactorEnrolment) redirect("/welcome");
  const cookieTheme = parseThemePref((await cookies()).get(THEME_COOKIE)?.value);
  const theme = cookieTheme === "system" ? session.user.theme : cookieTheme;
  return (
    <AppShell session={session} businessName={await businessName()} theme={theme}>
      {children}
    </AppShell>
  );
}
```
`AppShell` takes `session` and derives `can` from it:
```tsx
type Props = { session: Session; businessName: string; theme: ThemePref; children: ReactNode };
// inside:
const can = (p: string) => (isPermissionKey(p) ? canCore(session.actor, p) : false);
```
and passes `user={{ name: session.user.name, role: session.user.isOwner ? "Owner" : roleLabel }}` to `Sidebar` (role label: "Owner" when `isOwner`, otherwise "Admin" when they hold `users.manage`, else "Sales"). Keep the existing props of `Sidebar`/`TopBar` otherwise.

Add the tour targets while here (used in Task 7): `data-tour="brand"` on the sidebar lockup, `data-tour="nav-<id>"` on each nav link, `data-tour="search"` on the top-bar search, `data-tour="notifications"` on the bell, `data-tour="profile"` on the sidebar profile row.

`apps/web/src/proxy.ts` — add the redirect for signed-out visitors before the CSP work:
```ts
const PUBLIC_PATHS = [/^\/sign-in/, /^\/setup/, /^\/invite\//, /^\/forgot/, /^\/reset\//, /^\/design/];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const signedIn = request.cookies.has("__Host-lume_session");
  if (!signedIn && !PUBLIC_PATHS.some((p) => p.test(pathname))) {
    const to = request.nextUrl.clone();
    to.pathname = "/sign-in";
    to.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(to);
  }
  /* …existing nonce CSP work… */
}
```
(The cookie's presence is only a shortcut; `requireSession()` and the API remain the authority.)

`infra/docker-compose.yml` web service gains `environment: { LUME_API_URL: http://api:3001 }`, and `infra/compose.dev.yml`'s web service keeps `LUME_DESIGN_SHOWCASE: "1"`.

- [ ] **Step 5: Run to verify**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/web && pnpm --filter @lume/web typecheck'`
Expected: api (6) and session (2) pass. Existing web component tests that render `AppShell` need their props updated to the new `session` shape — update them to build a minimal session object with a helper `fakeSession(overrides)` added to `apps/web/src/server/session.ts` exports for tests (`export function fakeSession(o?: Partial<Session>): Session`), so no test hand-builds an actor.

- [ ] **Step 6: Strict gate, commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(web): real sessions and permissions from the API, browser client with CSRF and idempotency, signed-out redirect

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 3: Sign in, two-step code, recovery code, forgot and reset

**Files:**
- Modify: `apps/web/src/lib/auth-client.ts`, `apps/web/src/lib/auth-client.test.ts`, `apps/web/src/components/auth/SignInForm.tsx`, `apps/web/src/components/auth/SignInForm.test.tsx`, `apps/web/src/components/auth/auth.module.css`, `apps/web/src/app/sign-in/page.tsx`
- Create: `apps/web/src/components/auth/{SignInScreen,ForgotForm,ResetForm}.tsx`, `apps/web/src/components/auth/ResetForm.test.tsx`, `apps/web/src/app/forgot/page.tsx`, `apps/web/src/app/reset/[token]/page.tsx`, `apps/web/src/server/public-settings.ts`

**Interfaces:**
- Consumes: `api` (Task 2); `POST /api/v1/auth/{login,2fa,recovery,password/forgot,password/reset}` (1A).
- Produces:
  - `signIn(email, password): Promise<SignInResult>` where `SignInResult = { status: "ok" } | { status: "otp_required" } | { status: "invalid" } | { status: "locked"; retryAfterSec?: number } | { status: "unavailable" }`
  - `verifyOtp(code): Promise<AuthStep>`, `verifyRecoveryCode(code): Promise<AuthStep>`, `AuthStep = "ok" | "invalid" | "locked" | "unavailable"`
  - `requestPasswordReset(email): Promise<"sent" | "unavailable">`
  - `resetPassword(token, password): Promise<ResetResult>` where `ResetResult = { status: "ok" } | { status: "weak"; problems: string[] } | { status: "expired" } | { status: "unavailable" }`
  - `PASSWORD_PROBLEMS: Record<string, string>`, `passwordProblemText(problems: string[]): string`
  - `publicBusinessName(): Promise<string>` (server)
  - `SignInForm` props gain `onVerifyRecovery(code: string): Promise<AuthStep>`

- [ ] **Step 1: Write the failing tests**

Replace `apps/web/src/lib/auth-client.test.ts` with:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetCsrfForTests } from "./api";
import { requestPasswordReset, resetPassword, signIn, verifyOtp, verifyRecoveryCode } from "./auth-client";

const csrf = () =>
  new Response(JSON.stringify({ token: "t" }), { status: 200, headers: { "content-type": "application/json" } });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const route = (map: Record<string, () => Response>) =>
  vi.fn(async (url: string | URL) => {
    const key = String(url);
    if (key.endsWith("/auth/csrf")) return csrf();
    const hit = Object.entries(map).find(([p]) => key.endsWith(p));
    if (!hit) throw new Error(`unexpected ${key}`);
    return hit[1]();
  });

beforeEach(() => {
  resetCsrfForTests();
  vi.restoreAllMocks();
});

describe("sign in", () => {
  it("reports done, otp, wrong credentials and lockout with its wait", async () => {
    vi.stubGlobal("fetch", route({ "/auth/login": () => json(200, { next: "done" }) }));
    expect(await signIn("a@b.c", "pw")).toEqual({ status: "ok" });
    vi.stubGlobal("fetch", route({ "/auth/login": () => json(200, { next: "otp" }) }));
    expect(await signIn("a@b.c", "pw")).toEqual({ status: "otp_required" });
    vi.stubGlobal("fetch", route({ "/auth/login": () => json(401, { error: { code: "INVALID_CREDENTIALS", message: "no" } }) }));
    expect(await signIn("a@b.c", "pw")).toEqual({ status: "invalid" });
    vi.stubGlobal(
      "fetch",
      route({ "/auth/login": () => json(429, { error: { code: "TOO_MANY_ATTEMPTS", message: "wait", details: { retryAfterSec: 840 } } }) }),
    );
    expect(await signIn("a@b.c", "pw")).toEqual({ status: "locked", retryAfterSec: 840 });
  });

  it("verifies a code from the app and a recovery code", async () => {
    vi.stubGlobal("fetch", route({ "/auth/2fa": () => json(200, { next: "done" }) }));
    expect(await verifyOtp("123456")).toBe("ok");
    vi.stubGlobal("fetch", route({ "/auth/2fa": () => json(401, { error: { code: "INVALID_CODE", message: "no" } }) }));
    expect(await verifyOtp("123456")).toBe("invalid");
    vi.stubGlobal("fetch", route({ "/auth/recovery": () => json(200, { next: "done", remaining: 8 }) }));
    expect(await verifyRecoveryCode("AAAAA-BBBBB")).toBe("ok");
    vi.stubGlobal("fetch", route({ "/auth/recovery": () => json(429, { error: { code: "TOO_MANY_ATTEMPTS", message: "wait" } }) }));
    expect(await verifyRecoveryCode("AAAAA-BBBBB")).toBe("locked");
  });
});

describe("password reset", () => {
  it("always reports sent, so no address is confirmed or denied", async () => {
    vi.stubGlobal("fetch", route({ "/password/forgot": () => new Response(null, { status: 202 }) }));
    expect(await requestPasswordReset("ghost@nowhere.test")).toBe("sent");
  });

  it("separates a weak password from an expired link", async () => {
    vi.stubGlobal("fetch", route({ "/password/reset": () => new Response(null, { status: 204 }) }));
    expect(await resetPassword("t".repeat(43), "a long new passphrase")).toEqual({ status: "ok" });
    vi.stubGlobal(
      "fetch",
      route({ "/password/reset": () => json(400, { error: { code: "WEAK_PASSWORD", message: "weak", details: { problems: ["too_short"] } } }) }),
    );
    expect(await resetPassword("t".repeat(43), "short")).toEqual({ status: "weak", problems: ["too_short"] });
    vi.stubGlobal("fetch", route({ "/password/reset": () => json(400, { error: { code: "INVALID_TOKEN", message: "expired" } }) }));
    expect(await resetPassword("t".repeat(43), "a long new passphrase")).toEqual({ status: "expired" });
  });
});
```

Append to `apps/web/src/components/auth/SignInForm.test.tsx`:
```tsx
it("offers a recovery code after the app code, and verifies it", async () => {
  const onVerifyRecovery = vi.fn(async () => "ok" as const);
  render(
    <SignInForm
      businessName="Nupuur Coaching"
      onSignIn={async () => ({ status: "otp_required" })}
      onVerify={async () => "invalid"}
      onVerifyRecovery={onVerifyRecovery}
      onSuccess={() => {}}
    />,
  );
  await userEvent.type(screen.getByLabelText("Email"), "a@b.c");
  await userEvent.type(screen.getByLabelText("Password"), "pw");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await userEvent.click(await screen.findByRole("button", { name: /recovery code/i }));
  await userEvent.type(screen.getByLabelText("Recovery code"), "AAAAA-BBBBB");
  await userEvent.click(screen.getByRole("button", { name: "Use code" }));
  expect(onVerifyRecovery).toHaveBeenCalledWith("AAAAA-BBBBB");
});

it("says how long a lockout lasts", async () => {
  render(
    <SignInForm
      businessName="Nupuur Coaching"
      onSignIn={async () => ({ status: "locked", retryAfterSec: 900 })}
      onVerify={async () => "ok"}
      onVerifyRecovery={async () => "ok"}
      onSuccess={() => {}}
    />,
  );
  await userEvent.type(screen.getByLabelText("Email"), "a@b.c");
  await userEvent.type(screen.getByLabelText("Password"), "pw");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/15 minutes/);
});
```

`apps/web/src/components/auth/ResetForm.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ResetForm } from "./ResetForm";

describe("ResetForm", () => {
  it("explains a refused password in plain words and keeps the person on the page", async () => {
    const onReset = vi.fn(async () => ({ status: "weak" as const, problems: ["breached", "too_short"] }));
    render(<ResetForm businessName="Nupuur Coaching" onReset={onReset} onDone={() => {}} />);
    await userEvent.type(screen.getByLabelText("New password"), "password1");
    await userEvent.click(screen.getByRole("button", { name: "Save password" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/known data breach/i);
    expect(alert).toHaveTextContent(/at least 12/i);
    expect(screen.getByLabelText("New password")).toBeEnabled();
  });

  it("says plainly when the link has expired, and offers a new one", async () => {
    render(<ResetForm businessName="Nupuur Coaching" onReset={async () => ({ status: "expired" })} onDone={() => {}} />);
    await userEvent.type(screen.getByLabelText("New password"), "a long new passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/link has expired/i);
    expect(screen.getByRole("link", { name: /ask for a new link/i })).toHaveAttribute("href", "/forgot");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/lib/auth-client.test.ts apps/web/src/components/auth`
Expected: FAIL (`verifyRecoveryCode` and `ResetForm` don't exist).

- [ ] **Step 3: Implement the client calls**

Replace `apps/web/src/lib/auth-client.ts` with:
```ts
"use client";
import { api, type ApiResult } from "./api";

export type SignInResult =
  | { status: "ok" }
  | { status: "otp_required" }
  | { status: "invalid" }
  | { status: "locked"; retryAfterSec?: number }
  | { status: "unavailable" };
export type AuthStep = "ok" | "invalid" | "locked" | "unavailable";

const retryAfter = (r: Extract<ApiResult<unknown>, { ok: false }>): number | undefined => {
  const d = r.details as { retryAfterSec?: number } | undefined;
  return typeof d?.retryAfterSec === "number" ? d.retryAfterSec : undefined;
};

export async function signIn(email: string, password: string): Promise<SignInResult> {
  const r = await api.post<{ next: "otp" | "done" }>("/api/v1/auth/login", { email, password });
  if (r.ok) return r.data.next === "otp" ? { status: "otp_required" } : { status: "ok" };
  if (r.status === 401) return { status: "invalid" };
  if (r.status === 429) {
    const secs = retryAfter(r);
    return secs === undefined ? { status: "locked" } : { status: "locked", retryAfterSec: secs };
  }
  return { status: "unavailable" };
}

const step = (r: ApiResult<unknown>): AuthStep =>
  r.ok ? "ok" : r.status === 429 ? "locked" : r.status === 401 || r.status === 400 ? "invalid" : "unavailable";

export const verifyOtp = async (code: string): Promise<AuthStep> => step(await api.post("/api/v1/auth/2fa", { code }));
export const verifyRecoveryCode = async (code: string): Promise<AuthStep> =>
  step(await api.post("/api/v1/auth/recovery", { code }));

/** Always "sent": the API never reveals whether an address has an account (report §12.1). */
export async function requestPasswordReset(email: string): Promise<"sent" | "unavailable"> {
  const r = await api.post("/api/v1/auth/password/forgot", { email });
  return r.ok || r.status === 429 ? "sent" : "unavailable";
}

export type ResetResult =
  | { status: "ok" }
  | { status: "weak"; problems: string[] }
  | { status: "expired" }
  | { status: "unavailable" };

const problemsOf = (r: Extract<ApiResult<unknown>, { ok: false }>): string[] =>
  (r.details as { problems?: string[] } | undefined)?.problems ?? [];

export async function resetPassword(token: string, password: string): Promise<ResetResult> {
  const r = await api.post("/api/v1/auth/password/reset", { token, password });
  if (r.ok) return { status: "ok" };
  if (r.code === "WEAK_PASSWORD") return { status: "weak", problems: problemsOf(r) };
  if (r.code === "INVALID_TOKEN") return { status: "expired" };
  return { status: "unavailable" };
}

export type AcceptResult =
  | { status: "ok" }
  | { status: "weak"; problems: string[] }
  | { status: "gone" }
  | { status: "unavailable" };

export async function acceptInvite(token: string, password: string): Promise<AcceptResult> {
  const r = await api.post(`/api/v1/invites/${token}/accept`, { password });
  if (r.ok) return { status: "ok" };
  if (r.code === "WEAK_PASSWORD") return { status: "weak", problems: problemsOf(r) };
  if (r.status === 404 || r.code === "USER_EXISTS") return { status: "gone" };
  return { status: "unavailable" };
}

/** The API's password problems, in words a person can act on. */
export const PASSWORD_PROBLEMS: Record<string, string> = {
  too_short: "Use at least 12 characters — a short sentence works well.",
  too_long: "That’s too long; keep it under 256 characters.",
  breached: "That password has appeared in a known data breach. Pick something else.",
  contains_email: "Don’t use your email address inside your password.",
};
export const passwordProblemText = (problems: string[]): string =>
  problems.length ? problems.map((p) => PASSWORD_PROBLEMS[p] ?? "Pick a stronger password.").join(" ") : "Pick a stronger password.";
```

- [ ] **Step 4: Implement the screens**

`SignInForm` (same file and CSS, keeping the shake and `role="alert"` line):
- props gain `onVerifyRecovery(code: string): Promise<AuthStep>`;
- `step` becomes `"password" | "otp" | "recovery"`;
- the lockout message reads `Too many attempts. Try again in ${Math.ceil(secs / 60)} minutes.` when the API said how long, otherwise "in a few minutes";
- below the OTP input: `Use a recovery code instead` (a `button`, switching to the recovery step, which has a labelled `Recovery code` field, a `Use code` button and a way back);
- below the password fields: a link `Forgot your password?` → `/forgot`.

`apps/web/src/components/auth/SignInScreen.tsx` (client) holds the aura + form and does `router.replace(next)` on success. `apps/web/src/app/sign-in/page.tsx` becomes:
```tsx
import { SignInScreen } from "@/components/auth/SignInScreen";
import { publicBusinessName } from "@/server/public-settings";

/** Only in-app paths, so a crafted ?next= can never bounce someone off-site. */
const safeNext = (next: string | undefined): string => (next && /^\/[A-Za-z0-9\-_/]*$/.test(next) ? next : "/today");

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <SignInScreen businessName={await publicBusinessName()} next={safeNext(next)} />;
}
```

`apps/web/src/server/public-settings.ts`:
```ts
import { cache } from "react";
import { apiGet } from "./api";

/**
 * The business name for signed-out screens. `GET /settings` needs a session, so a stranger simply sees
 * "LUME" — never an error, and never the client's name.
 */
export const publicBusinessName = cache(async (): Promise<string> => {
  const { status, data } = await apiGet<{ businessName: string }>("/api/v1/settings");
  return status === 200 && data?.businessName ? data.businessName : "LUME";
});
```

`ForgotForm` (client): one `Email` field; after submitting, the same calm confirmation either way — "If that address has an account, a reset link is on its way. It expires in 30 minutes." — plus a link back to sign in. `apps/web/src/app/forgot/page.tsx` renders it with `publicBusinessName()`.

`ResetForm` (client): `New password` with a show/hide toggle and the live hint "At least 12 characters. A short sentence is easiest to remember."; `Save password`; `role="alert"` messages from `passwordProblemText`; the expired case adds a link `Ask for a new link` → `/forgot`; on success a brief "Password saved" then `router.replace("/sign-in")`. `apps/web/src/app/reset/[token]/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { ResetScreen } from "@/components/auth/ResetScreen";
import { publicBusinessName } from "@/server/public-settings";

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) notFound();
  return <ResetScreen token={token} businessName={await publicBusinessName()} />;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/web && pnpm --filter @lume/web typecheck'`
Expected: auth-client (4), SignInForm (existing plus 2), ResetForm (2) green.

- [ ] **Step 6: Strict gate, commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(web): sign-in wired to the API, recovery-code path, lockout wording, forgot and reset screens

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 4: Invite acceptance

**Files:**
- Create: `apps/web/src/app/invite/[token]/page.tsx`, `apps/web/src/app/invite/not-found.tsx`, `apps/web/src/components/auth/{AcceptInvite,AcceptInviteScreen}.tsx`, `apps/web/src/components/auth/AcceptInvite.test.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/invites/:token`, `POST /api/v1/invites/:token/accept` (1A); `acceptInvite` (Task 3).
- Produces: `AcceptInvite` props `{ invite: { email: string; name: string; businessName: string }; onAccept(password: string): Promise<AcceptResult>; onDone(): void }`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/components/auth/AcceptInvite.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AcceptInvite } from "./AcceptInvite";

const invite = { email: "riya@nupuur.com", name: "Riya", businessName: "Nupuur Coaching" };

describe("AcceptInvite", () => {
  it("shows who the invite is for, and the address cannot be changed", () => {
    render(<AcceptInvite invite={invite} onAccept={async () => ({ status: "ok" })} onDone={() => {}} />);
    expect(screen.getByText(/Nupuur Coaching/)).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("riya@nupuur.com");
    expect(screen.getByLabelText("Email")).toBeDisabled();
  });

  it("explains a refused password and lets the person try again", async () => {
    const onAccept = vi.fn(async () => ({ status: "weak" as const, problems: ["breached"] }));
    render(<AcceptInvite invite={invite} onAccept={onAccept} onDone={() => {}} />);
    await userEvent.type(screen.getByLabelText("Choose a password"), "password123456");
    await userEvent.click(screen.getByRole("button", { name: "Join LUME" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/known data breach/i);
    expect(screen.getByLabelText("Choose a password")).toBeEnabled();
  });

  it("says plainly when the invite is no longer usable", async () => {
    render(<AcceptInvite invite={invite} onAccept={async () => ({ status: "gone" })} onDone={() => {}} />);
    await userEvent.type(screen.getByLabelText("Choose a password"), "a long new passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Join LUME" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already been used or has expired/i);
  });

  it("hands over to onboarding once accepted", async () => {
    const onDone = vi.fn();
    render(<AcceptInvite invite={invite} onAccept={async () => ({ status: "ok" })} onDone={onDone} />);
    await userEvent.type(screen.getByLabelText("Choose a password"), "a long new passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Join LUME" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/components/auth/AcceptInvite.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`apps/web/src/app/invite/[token]/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { AcceptInviteScreen } from "@/components/auth/AcceptInviteScreen";
import { apiGet } from "@/server/api";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) notFound();
  const { status, data } = await apiGet<{ email: string; name: string; businessName: string }>(
    `/api/v1/invites/${token}`,
  );
  // Unknown, used or expired is a 404 from the API and a 404 here: no hints either way.
  if (status !== 200 || !data) notFound();
  return <AcceptInviteScreen token={token} invite={data} />;
}
```
`AcceptInvite` (client): "You're invited to <business>" with `LUME` above it, the disabled `Email`, a `Choose a password` field with show/hide and the same hint as reset, a `Join LUME` button, `role="alert"` errors via `passwordProblemText`, and the "This invite has already been used or has expired" message with a link to `/sign-in`. `AcceptInviteScreen` wires `onAccept={(pw) => acceptInvite(token, pw)}` and `onDone={() => router.replace("/welcome")}` — the API signs them in, so onboarding is next.

`apps/web/src/app/invite/not-found.tsx` explains that the link is no longer valid and links to `/sign-in`, so a dead invite looks designed rather than broken.

- [ ] **Step 4: Run to verify**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/web && pnpm --filter @lume/web typecheck'`
Expected: AcceptInvite (4) green with the rest.

- [ ] **Step 5: Strict gate, commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(web): invite acceptance with clear password feedback and a designed dead-link page

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 5: First-run setup wizard

**Files:**
- Create: `apps/web/src/lib/timezones.ts`, `apps/web/src/lib/timezones.test.ts`, `apps/web/src/lib/qr.ts`, `apps/web/src/lib/qr.test.ts`, `apps/web/src/lib/setup-client.ts`
- Create: `apps/web/src/app/setup/page.tsx`, `apps/web/src/components/setup/{SetupScreen,SetupWizard,RecoveryCodes,QrCode}.tsx`, `apps/web/src/components/setup/setup.module.css`, `apps/web/src/components/setup/SetupWizard.test.tsx`
- Create: `apps/web/src/components/ui/{Field,TimezonePicker}.tsx`, `apps/web/src/components/ui/Field.module.css`

**Interfaces:**
- Consumes: `GET /api/v1/setup/status`, `POST /api/v1/setup/totp`, `POST /api/v1/setup` (1A).
- Produces:
  - `timezoneOptions(): TimezoneOption[]` (`{ id; label; offset }`), `searchTimezones(q): TimezoneOption[]`, `guessTimezone(): string`, `formatOffset(id, at?): string`, `CURRENCIES: string[]`, `COUNTRIES: { iso; name }[]`
  - `qrMatrix(text: string): boolean[][]` — a local QR encoder (byte mode, EC level M), and `<QrCode text size />`
  - `startTotp(token): Promise<{ secret; otpauthUri } | { error: string }>`, `completeSetup(input: SetupInput): Promise<SetupResult>`
  - `<Field label hint error>…</Field>` — the shared labelled field used by every form from here on
  - `<TimezonePicker value onChange />` — searchable list with the current local time per zone

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/timezones.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatOffset, guessTimezone, searchTimezones, timezoneOptions } from "./timezones";

describe("timezones", () => {
  it("lists real zones with a readable label and their current offset", () => {
    const all = timezoneOptions();
    expect(all.length).toBeGreaterThan(100);
    const dubai = all.find((z) => z.id === "Asia/Dubai")!;
    expect(dubai.label).toBe("Dubai");
    expect(dubai.offset).toBe("UTC+4");
  });

  it("finds a zone by city, by id and by offset", () => {
    expect(searchTimezones("dubai").map((z) => z.id)).toContain("Asia/Dubai");
    expect(searchTimezones("asia/kol").map((z) => z.id)).toContain("Asia/Kolkata");
    expect(searchTimezones("+4").map((z) => z.id)).toContain("Asia/Dubai");
    expect(searchTimezones("zzzz")).toEqual([]);
  });

  it("guesses a zone that really exists, and formats UTC as UTC+0", () => {
    expect(timezoneOptions().some((z) => z.id === guessTimezone())).toBe(true);
    expect(formatOffset("UTC")).toBe("UTC+0");
  });
});
```

`apps/web/src/lib/qr.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { qrMatrix } from "./qr";

describe("QR encoder (local, so a TOTP secret never leaves the machine)", () => {
  it("produces a square matrix of a valid size with the three finder patterns", () => {
    const m = qrMatrix("otpauth://totp/LUME:owner?secret=JBSWY3DPEHPK3PXP");
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect((m.length - 21) % 4).toBe(0);
    expect(m.every((row) => row.length === m.length)).toBe(true);
    const finder = (r: number, c: number) => m[r]![c] && m[r + 6]![c] && m[r]![c + 6] && !m[r + 1]![c + 1];
    expect(finder(0, 0)).toBe(true);
    expect(finder(0, m.length - 7)).toBe(true);
    expect(finder(m.length - 7, 0)).toBe(true);
  });

  it("grows with longer input and is stable for the same input", () => {
    const small = qrMatrix("otpauth://totp/A?secret=AAAA");
    const big = qrMatrix(`otpauth://totp/${"L".repeat(120)}?secret=${"B".repeat(52)}`);
    expect(big.length).toBeGreaterThan(small.length);
    expect(qrMatrix("same")).toEqual(qrMatrix("same"));
  });
});
```

`apps/web/src/components/setup/SetupWizard.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SetupWizard } from "./SetupWizard";

const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const props = () => ({
  onStartTotp: vi.fn(async () => ({ secret, otpauthUri: `otpauth://totp/LUME:owner?secret=${secret}` })),
  onComplete: vi.fn(async () => ({
    status: "ok" as const,
    recoveryCodes: Array.from({ length: 10 }, (_, i) => `CODE${i}-XXXXX`),
  })),
  onDone: vi.fn(),
});

async function fillToTwoFactor(p: ReturnType<typeof props>) {
  render(<SetupWizard {...p} />);
  await userEvent.type(screen.getByLabelText("Setup token"), "token-from-the-server-logs");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await userEvent.type(screen.getByLabelText("Business name"), "Nupuur Coaching");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await userEvent.type(screen.getByLabelText("Your name"), "Nupuur Patil");
  await userEvent.type(screen.getByLabelText("Email"), "nupuur@nupuur.com");
  await userEvent.type(screen.getByLabelText("Password"), "a long and lovely passphrase");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("SetupWizard", () => {
  it("walks token → business → owner → two-step → recovery codes", async () => {
    const p = props();
    await fillToTwoFactor(p);
    expect(p.onStartTotp).toHaveBeenCalledWith("token-from-the-server-logs");
    // The key is shown for anyone who can't scan the QR code.
    expect(await screen.findByText(new RegExp(secret.slice(0, 8)))).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("6-digit code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(await screen.findByText("CODE0-XXXXX")).toBeInTheDocument();
    expect(screen.getByText(/save these somewhere safe/i)).toBeInTheDocument();
    expect(p.onDone).not.toHaveBeenCalled(); // not until they confirm they saved them
    await userEvent.click(screen.getByRole("checkbox", { name: /saved/i }));
    await userEvent.click(screen.getByRole("button", { name: /open lume/i }));
    expect(p.onDone).toHaveBeenCalled();
    const sent = p.onComplete.mock.calls[0]![0];
    expect(sent).toMatchObject({
      token: "token-from-the-server-logs",
      preset: "coaching",
      business: { name: "Nupuur Coaching", currency: "AED" },
      owner: { name: "Nupuur Patil", email: "nupuur@nupuur.com" },
      totp: { secret, code: "123456" },
    });
  });

  it("keeps the person on the token step when the token is refused", async () => {
    const p = { ...props(), onStartTotp: vi.fn(async () => ({ error: "That setup token isn’t valid" })) };
    render(<SetupWizard {...p} />);
    await userEvent.type(screen.getByLabelText("Setup token"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/isn’t valid/);
    expect(screen.getByLabelText("Setup token")).toBeInTheDocument();
  });

  it("explains a refused code without losing anything typed", async () => {
    const p = { ...props(), onComplete: vi.fn(async () => ({ status: "code" as const })) };
    await fillToTwoFactor(p);
    await userEvent.type(screen.getByLabelText("6-digit code"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/didn’t work/i);
    expect(screen.getByLabelText("6-digit code")).toBeInTheDocument();
  });

  it("explains a refused password and returns to the owner step", async () => {
    const p = { ...props(), onComplete: vi.fn(async () => ({ status: "weak" as const, problems: ["breached"] })) };
    await fillToTwoFactor(p);
    await userEvent.type(screen.getByLabelText("6-digit code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/known data breach/i);
    expect(screen.getByLabelText("Password")).toHaveValue("a long and lovely passphrase");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/lib/timezones.test.ts apps/web/src/lib/qr.test.ts apps/web/src/components/setup`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the platform-data helpers**

`apps/web/src/lib/timezones.ts`:
```ts
/** Timezone, currency and country lists built from the platform's own data — nothing bundled. */
export type TimezoneOption = { id: string; label: string; offset: string };

const supportedValues = (key: string): string[] => {
  const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  try {
    return fn ? fn(key) : [];
  } catch {
    return [];
  }
};

export function formatOffset(id: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: id, timeZoneName: "shortOffset" }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name.replace("GMT", "UTC").replace(/^UTC$/, "UTC+0");
}

/** The city is what people recognise; the full id stays available for search. */
const labelOf = (id: string) => id.split("/").at(-1)!.replace(/_/g, " ");

let zones: TimezoneOption[] | null = null;
export function timezoneOptions(): TimezoneOption[] {
  if (!zones) {
    const ids = supportedValues("timeZone");
    const list = ids.length ? ids : ["UTC", "Asia/Dubai", "Asia/Kolkata", "Europe/London", "America/New_York"];
    zones = list.map((id) => ({ id, label: labelOf(id), offset: formatOffset(id) })).sort((a, b) => a.label.localeCompare(b.label));
  }
  return zones;
}

export function searchTimezones(q: string): TimezoneOption[] {
  const term = q.trim().toLowerCase();
  if (!term) return timezoneOptions();
  const asOffset = term.replace(/^utc/, "").replace(/^([+-])0(\d)$/, "$1$2");
  return timezoneOptions().filter(
    (z) =>
      z.label.toLowerCase().includes(term) ||
      z.id.toLowerCase().includes(term) ||
      z.offset.toLowerCase().replace("utc", "") === asOffset,
  );
}

export function guessTimezone(): string {
  const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezoneOptions().some((z) => z.id === guess) ? guess : "UTC";
}

export function localTime(id: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: id, hour: "numeric", minute: "2-digit" }).format(at).toLowerCase();
}

/** Common currencies first, then whatever else the platform knows. */
export const CURRENCIES: string[] = (() => {
  const common = ["AED", "INR", "USD", "EUR", "GBP", "SAR", "AUD", "CAD", "SGD"];
  const all = supportedValues("currency");
  return [...common, ...all.filter((c) => !common.includes(c))];
})();

export type CountryOption = { iso: string; name: string };
/** The markets LUME's first clients sell into; the full phone-country list arrives with sheet intake. */
export const COUNTRIES: CountryOption[] = (() => {
  const isoList =
    "AE IN US GB SA QA KW OM BH CA AU NZ SG MY ID PH TH VN CN JP KR DE FR IT ES NL BE SE NO DK IE PT PL ZA KE NG EG BR MX AR CL".split(
      " ",
    );
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  return isoList.map((iso) => ({ iso, name: names.of(iso) ?? iso })).sort((a, b) => a.name.localeCompare(b.name));
})();
```

`apps/web/src/lib/qr.ts` — a small QR encoder so the TOTP secret never leaves the machine. Implement byte mode with error-correction level **M**, versions 1–10, choosing the smallest version that fits:

```ts
/**
 * Minimal QR encoder (byte mode, EC level M, versions 1–10) — enough for an otpauth:// URI.
 * Local on purpose: a TOTP secret must never be sent to a QR service (report §12.5 spirit).
 * Reference: ISO/IEC 18004. Only what we need is implemented, and `qr.test.ts` pins the output.
 */
export function qrMatrix(text: string): boolean[][] { /* see implementation notes below */ }
```
Implementation notes for the engineer (write them as code, in this order, with small named functions):
1. `gfMul/gfExp/gfLog` tables for GF(256) with the QR primitive `0x11d`.
2. `rsGenerator(degree)` and `rsRemainder(data, degree)` for the error-correction codewords.
3. `CAPACITY_M: Record<version, { total: number; ecPerBlock: number; blocks: number }>` for versions 1–10 (from the standard's tables; the test only checks sizes, so transcribe carefully and keep the source comment).
4. `encodeBytes(text, version)`: mode indicator `0100`, 8-bit character count for versions 1–9 and 16-bit for 10, the UTF-8 bytes, terminator, pad to capacity with `0xEC 0x11`.
5. Interleave data and EC blocks per the standard.
6. `place(matrix, bits)`: finder patterns, separators, timing patterns, the single alignment pattern for versions 2+, the dark module, format and version information, then the zig-zag data placement skipping function patterns.
7. Apply mask pattern 0 and write the format bits for it (a single mask keeps this small; readers handle any mask).
8. Return the matrix as `boolean[][]`, `true` = dark.

`<QrCode text size={168} />` renders it as a single inline `<svg>` of rects with `shape-rendering="crispEdges"`, `role="img"` and an `aria-label` of "QR code for your authenticator app", on a white plate (a QR code must stay high-contrast in both themes, so the plate is always white).

`apps/web/src/lib/setup-client.ts`:
```ts
"use client";
import { api } from "./api";

export type SetupInput = {
  token: string;
  business: { name: string; timezone: string; currency: string; defaultCountry: string };
  preset: "coaching" | "general";
  owner: { name: string; email: string; password: string };
  totp: { secret: string; code: string };
};
export type SetupResult =
  | { status: "ok"; recoveryCodes: string[] }
  | { status: "token" }
  | { status: "code" }
  | { status: "weak"; problems: string[] }
  | { status: "unavailable" };

export async function startTotp(token: string): Promise<{ secret: string; otpauthUri: string } | { error: string }> {
  const r = await api.post<{ secret: string; otpauthUri: string }>("/api/v1/setup/totp", { token });
  if (r.ok) return r.data;
  return {
    error: r.code === "SETUP_TOKEN" ? "That setup token isn’t valid. Copy it from the server logs." : r.message,
  };
}

export async function completeSetup(input: SetupInput): Promise<SetupResult> {
  const r = await api.post<{ recoveryCodes: string[] }>("/api/v1/setup", input);
  if (r.ok) return { status: "ok", recoveryCodes: r.data.recoveryCodes };
  if (r.code === "SETUP_TOKEN") return { status: "token" };
  if (r.code === "INVALID_CODE") return { status: "code" };
  if (r.code === "WEAK_PASSWORD") return { status: "weak", problems: (r.details as { problems?: string[] })?.problems ?? [] };
  return { status: "unavailable" };
}
```

- [ ] **Step 4: Implement the wizard**

`apps/web/src/app/setup/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { SetupScreen } from "@/components/setup/SetupScreen";
import { apiGet } from "@/server/api";

export default async function SetupPage() {
  const { data } = await apiGet<{ needsSetup: boolean }>("/api/v1/setup/status");
  // Already set up: the wizard must never be reachable a second time.
  if (!data?.needsSetup) redirect("/sign-in");
  return <SetupScreen />;
}
```

`SetupWizard` (client) — four steps on the signed-out canvas, one per screen, with "Step 2 of 4" and the same slim progress bar the tour uses:

1. **Token** — explains where it comes from ("LUME printed it in the server logs when it started"), one `Setup token` field. `Continue` calls `onStartTotp(token)`; a refusal shows the message and stays.
2. **Business** — `Business name`, `Timezone` (`TimezonePicker`, pre-filled from `guessTimezone()`, showing each zone's current time), `Currency` (default `AED`), `Default country` (default `AE`), and the preset as two cards: **Coaching / consulting** (pre-selected, listing "New → Message sent → Replied → Call booked → Call done → Follow-up later → Won / Lost, plus Struggles and Handled by") and **General sales**.
3. **Owner** — `Your name`, `Email`, `Password` (show/hide, live hint).
4. **Two-step sign-in** — `<QrCode text={otpauthUri} />`, the secret in `<code>` for anyone who can't scan, `OtpInput` labelled `6-digit code`, `Finish setup`. A `code` failure stays here; a `weak` failure returns to step 3 with everything still filled in and the reason shown; a `token` failure returns to step 1.
5. **Recovery codes** (not counted in the four steps) — the ten codes, `Copy all`, `Download .txt`, a required checkbox "I've saved these somewhere safe", then `Open LUME` → `onDone()`, which `SetupScreen` implements as `router.replace("/welcome")`.

`<Field>` is the shared labelled wrapper used here and everywhere after: renders `<label>` bound by id, optional hint, optional `role="alert"` error, and marks the control `aria-invalid` when there's an error.

- [ ] **Step 5: Run to verify**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/web && pnpm --filter @lume/web typecheck'`
Expected: timezones (3), qr (2), SetupWizard (4) green with the rest.

- [ ] **Step 6: Strict gate, commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(web): first-run setup wizard with a local QR encoder, preset choice and saved recovery codes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 6: Onboarding — the glass sheet over the app

**Files:**
- Create: `apps/web/src/app/welcome/page.tsx`, `apps/web/src/components/onboarding/{Onboarding,Rail,ConnectCards}.tsx`, `apps/web/src/components/onboarding/panels/{Welcome,You,Secure,Look,Day,Alerts,Team,Pipeline,Connect,Done}.tsx`, `apps/web/src/components/onboarding/onboarding.module.css`, `apps/web/src/components/onboarding/Onboarding.test.tsx`, `apps/web/src/lib/onboarding-client.ts`
- Create: `apps/web/public/brand/{google-calendar.svg,google-sheets.svg,google-g.svg}` (Google's official files, unmodified)
- Modify: `apps/web/src/lib/theme.ts` (a client helper to set the cookie), `apps/web/src/components/shell/AppShell.tsx` (blurred behind the sheet)

**Interfaces:**
- Consumes: `getSession()` (Task 2), `onboardingStepsFor`, `PREFERENCES_DEFAULTS` (Task 1), `api` (Task 2), `GET /api/v1/{users,pipelines}`, `POST /api/v1/invites`, `POST /api/v1/me/2fa/{enrol,confirm}`, `PATCH /api/v1/me`, `PUT /api/v1/me/onboarding`.
- Produces:
  - `type OnboardingActions = { saveProfile(p: { name?: string; timezone?: string; theme?: ThemePref }): Promise<boolean>; savePreferences(p: PreferencesPatch): Promise<boolean>; markStep(step: OnboardingStepId): Promise<void>; skipStep(step: OnboardingStepId): Promise<void>; complete(): Promise<void>; startEnrolment(): Promise<{ secret: string; otpauthUri: string } | null>; confirmEnrolment(code: string): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; message: string }>; listPeople(): Promise<Person[]>; invite(email: string, name: string, roleId: string): Promise<{ ok: boolean; message?: string }>; listRoles(): Promise<{ id: string; name: string }[]>; listPipeline(): Promise<Pipeline | null>; renameStage(id: string, name: string): Promise<boolean>; reorderStages(pipelineId: string, stageIds: string[]): Promise<boolean> }`
  - `<Onboarding session actions onFinished />` — the whole flow, driven by `onboardingStepsFor`
  - `onboardingActions(): OnboardingActions` in `onboarding-client.ts` (the real implementations)

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/onboarding/Onboarding.test.tsx`:
```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREFERENCES_DEFAULTS } from "@lume/core";
import { fakeSession } from "@/server/session";
import { Onboarding } from "./Onboarding";

const actions = () => ({
  saveProfile: vi.fn(async () => true),
  savePreferences: vi.fn(async () => true),
  markStep: vi.fn(async () => {}),
  skipStep: vi.fn(async () => {}),
  complete: vi.fn(async () => {}),
  startEnrolment: vi.fn(async () => ({ secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/LUME" })),
  confirmEnrolment: vi.fn(async () => ({ ok: true as const, recoveryCodes: ["AAAAA-BBBBB"] })),
  listPeople: vi.fn(async () => [{ id: "u9", name: "Nupuur Patil", email: "n@x.com", role: "Owner", pending: false }]),
  listRoles: vi.fn(async () => [{ id: "r-sales", name: "Sales" }]),
  invite: vi.fn(async () => ({ ok: true })),
  listPipeline: vi.fn(async () => ({
    id: "p1",
    name: "Coaching sales",
    stages: [
      { id: "s1", name: "New", kind: "open", color: "accent" },
      { id: "s2", name: "Won", kind: "won", color: "ok" },
      { id: "s3", name: "Lost", kind: "lost", color: "danger" },
    ],
  })),
  renameStage: vi.fn(async () => true),
  reorderStages: vi.fn(async () => true),
});

const rep = () =>
  fakeSession({
    user: { id: "u1", name: "Riya Sharma", email: "riya@x.com", isOwner: false, theme: "system", timezone: null },
    permissions: [{ key: "leads.view", scope: "own" }],
    preferences: PREFERENCES_DEFAULTS,
  });

beforeEach(() => vi.restoreAllMocks());

describe("Onboarding", () => {
  it("shows a rep the personal steps only, and the app stays visible behind", async () => {
    const a = actions();
    render(<Onboarding session={rep()} actions={a} onFinished={() => {}} />);
    const rail = screen.getByRole("navigation", { name: /steps/i });
    expect(within(rail).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Welcome",
      "You",
      "Look",
      "Your day",
      "Alerts",
      "All set",
    ]);
    expect(screen.getByRole("dialog", { name: /welcome to lume/i })).toBeInTheDocument();
  });

  it("saves the name and timezone, then records the step", async () => {
    const a = actions();
    render(<Onboarding session={rep()} actions={a} onFinished={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    await userEvent.clear(screen.getByLabelText("Your name"));
    await userEvent.type(screen.getByLabelText("Your name"), "Riya S");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(a.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ name: "Riya S" }));
    expect(a.markStep).toHaveBeenCalledWith("look");
  });

  it("records a skipped step and moves on", async () => {
    const a = actions();
    render(<Onboarding session={rep()} actions={a} onFinished={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(a.skipStep).toHaveBeenCalledWith("you");
  });

  it("previews the theme live and saves the choice", async () => {
    const a = actions();
    render(<Onboarding session={rep()} actions={a} onFinished={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("radio", { name: /obsidian/i }));
    expect(document.documentElement.dataset.theme).toBe("obsidian");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(a.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ theme: "obsidian" }));
  });

  it("turns working days and times into one plain sentence, and saves them", async () => {
    const a = actions();
    render(<Onboarding session={rep()} actions={a} onFinished={() => {}} />);
    for (const label of [/let’s go/i, /^Continue$/, /^Continue$/]) await userEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByTestId("day-preview")).toHaveTextContent(/Monday to Friday/);
    await userEvent.click(screen.getByRole("button", { name: "Sat" }));
    expect(screen.getByTestId("day-preview")).toHaveTextContent(/Mon, Tue, Wed, Thu, Fri, Sat/);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(a.savePreferences).toHaveBeenCalledWith(expect.objectContaining({ workingDays: [1, 2, 3, 4, 5, 6] }));
  });

  it("finishes by completing onboarding and handing over to the tour", async () => {
    const a = actions();
    const onFinished = vi.fn();
    render(<Onboarding session={rep()} actions={a} onFinished={onFinished} />);
    for (const label of [/let’s go/i, /^Continue$/, /^Continue$/, /^Continue$/, /^Continue$/]) {
      await userEvent.click(screen.getByRole("button", { name: label }));
    }
    await userEvent.click(screen.getByRole("button", { name: /take the tour/i }));
    expect(a.complete).toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledWith({ startTour: true });
  });

  it("makes an admin enrol in two-step sign-in before anything past it", async () => {
    const a = actions();
    const admin = fakeSession({
      user: { id: "u2", name: "Tasneem Shaikh", email: "t@x.com", isOwner: false, theme: "system", timezone: null },
      permissions: [{ key: "users.manage", scope: null }],
      twoFactor: { enabled: false, required: true },
      flags: { needsOnboarding: true, needsTwoFactorEnrolment: true, needsTour: true },
    });
    render(<Onboarding session={admin} actions={a} onFinished={() => {}} />);
    const rail = screen.getByRole("navigation", { name: /steps/i });
    expect(within(rail).getAllByRole("button").map((b) => b.textContent?.replace("Required", "").trim())).toEqual([
      "Welcome",
      "You",
      "Secure account",
      "Look",
      "Your day",
      "Alerts",
      "Your team",
      "All set",
    ]);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" })); // past You
    expect(await screen.findByText(/authenticator/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("6-digit code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(a.confirmEnrolment).toHaveBeenCalledWith("123456");
    expect(await screen.findByText("AAAAA-BBBBB")).toBeInTheDocument(); // recovery codes, once
  });

  it("lets an owner invite the team and shows who is already there", async () => {
    const a = actions();
    const owner = fakeSession({
      user: { id: "u3", name: "Nupuur Patil", email: "n@x.com", isOwner: true, theme: "system", timezone: null },
      permissions: [],
      twoFactor: { enabled: true, required: true },
    });
    render(<Onboarding session={owner} actions={a} onFinished={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    for (let i = 0; i < 4; i++) await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Nupuur Patil")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Email"), "riya@nupuur.com");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(a.invite).toHaveBeenCalledWith("riya@nupuur.com", "Riya", "r-sales");
    expect(await screen.findByText(/invite sent/i)).toBeInTheDocument();
  });

  it("hides Connect until an integration exists, and shows both cards when they do", async () => {
    const a = actions();
    const owner = (caps: { sheets: boolean; calendar: boolean }) =>
      fakeSession({
        user: { id: "u3", name: "Nupuur Patil", email: "n@x.com", isOwner: true, theme: "system", timezone: null },
        twoFactor: { enabled: true, required: true },
        capabilities: caps,
      });
    const { unmount } = render(<Onboarding session={owner({ sheets: false, calendar: false })} actions={a} onFinished={() => {}} />);
    expect(within(screen.getByRole("navigation", { name: /steps/i })).queryByText("Connect")).not.toBeInTheDocument();
    unmount();
    render(<Onboarding session={owner({ sheets: true, calendar: true })} actions={a} onFinished={() => {}} />);
    expect(within(screen.getByRole("navigation", { name: /steps/i })).getByText("Connect")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/components/onboarding`
Expected: FAIL, module not found. (`fakeSession` was added in Task 2.)

- [ ] **Step 3: Implement the page and actions**

`apps/web/src/app/welcome/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { WelcomeScreen } from "@/components/onboarding/WelcomeScreen";
import { businessName, requireSession } from "@/server/session";

export default async function WelcomePage() {
  const session = await requireSession();
  // Nothing to do here once onboarding is done and any required enrolment is finished.
  if (!session.flags.needsOnboarding && !session.flags.needsTwoFactorEnrolment) redirect("/today");
  return <WelcomeScreen session={session} businessName={await businessName()} />;
}
```
`WelcomeScreen` (client) renders the blurred app behind (a static, non-interactive copy of the shell: sidebar with the real business name and the person's nav, and a muted Today page), the aura, and `<Onboarding session actions={onboardingActions()} onFinished={…} />`. `onFinished({ startTour })` does `router.replace(startTour ? "/today?tour=1" : "/today")`.

`apps/web/src/lib/onboarding-client.ts` implements `OnboardingActions` over `api`:
```ts
"use client";
import type { PreferencesPatch } from "@lume/core";
import { api } from "./api";
import { setThemeCookie, type ThemePref } from "./theme";

export type Person = { id: string; name: string; email: string; role: string; pending: boolean };
export type Pipeline = { id: string; name: string; stages: { id: string; name: string; kind: string; color: string }[] };

export function onboardingActions() {
  return {
    async saveProfile(p: { name?: string; timezone?: string; theme?: ThemePref }) {
      if (p.theme) setThemeCookie(p.theme); // so the next server render matches immediately
      return (await api.patch("/api/v1/me", p)).ok;
    },
    async savePreferences(preferences: PreferencesPatch) {
      return (await api.patch("/api/v1/me", { preferences })).ok;
    },
    async markStep(step: string) {
      await api.put("/api/v1/me/onboarding", { step });
    },
    async skipStep(step: string) {
      await api.put("/api/v1/me/onboarding", { skip: step });
    },
    async complete() {
      await api.put("/api/v1/me/onboarding", { completed: true });
    },
    async startEnrolment() {
      const r = await api.post<{ secret: string; otpauthUri: string }>("/api/v1/me/2fa/enrol");
      return r.ok ? r.data : null;
    },
    async confirmEnrolment(code: string) {
      const r = await api.post<{ recoveryCodes: string[] }>("/api/v1/me/2fa/confirm", { code });
      return r.ok ? { ok: true as const, recoveryCodes: r.data.recoveryCodes } : { ok: false as const, message: r.message };
    },
    async listPeople(): Promise<Person[]> {
      const r = await api.get<{ users: { id: string; name: string; email: string; status: string; isOwner: boolean; roles: { name: string }[] }[] }>(
        "/api/v1/users",
      );
      if (!r.ok) return [];
      return r.data.users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.isOwner ? "Owner" : (u.roles[0]?.name ?? "No role"),
        pending: u.status === "invited",
      }));
    },
    async listRoles() {
      const r = await api.get<{ roles: { id: string; name: string }[] }>("/api/v1/roles");
      return r.ok ? r.data.roles.map((x) => ({ id: x.id, name: x.name })) : [];
    },
    async invite(email: string, name: string, roleId: string) {
      const r = await api.post("/api/v1/invites", { email, name, roleIds: [roleId] });
      return r.ok ? { ok: true } : { ok: false, message: r.message };
    },
    async listPipeline(): Promise<Pipeline | null> {
      const r = await api.get<{ pipelines: Pipeline[] }>("/api/v1/pipelines");
      return r.ok ? (r.data.pipelines[0] ?? null) : null;
    },
    async renameStage(id: string, name: string) {
      return (await api.patch(`/api/v1/stages/${id}`, { name })).ok;
    },
    async reorderStages(pipelineId: string, stageIds: string[]) {
      return (await api.put(`/api/v1/pipelines/${pipelineId}/stage-order`, { stageIds })).ok;
    },
  };
}
```
This needs a `get` on the browser client: add `get: <T>(path: string) => send<T>("GET", path)` to `api` in `lib/api.ts` (no Idempotency-Key is sent for GET — guard that in `send`), and `setThemeCookie(pref)` to `lib/theme.ts` (`document.cookie = themeCookie(pref)`).

- [ ] **Step 4: Implement the sheet and panels**

`Onboarding` (client) owns the flow:
- `const steps = onboardingStepsFor({ actor: session.actor, twoFactorEnabled: session.twoFactor.enabled, capabilities: session.capabilities })`.
- Current index in state, starting at the stored `session.onboarding.step` when it is still in the list, else 0.
- The sheet is `role="dialog"` with `aria-label={"Welcome to LUME, " + firstName}`, focus moved to the panel heading on each step, Escape does nothing (this is the way in, not a dismissable dialog), and the rail is `<nav aria-label="Onboarding steps">` with one `button` per step: done steps show a tick and are clickable, the current one is marked `aria-current="step"`, later ones are `disabled`.
- A **required** step (`secure`) disables Skip and disables every later rail button until it is verified.
- `Continue` runs that panel's `save()` (which returns `false` on failure and shows the panel's own `role="alert"` message, keeping the person on the step), then `markStep(nextId)` and moves on. `Skip` calls `skipStep(currentId)` and moves on.
- The last panel's buttons are `Take the tour` and `Explore on my own`; both call `complete()` then `onFinished({ startTour })`. The achievement chime plays once here (`sound.play("done")`).

Panels, each a small file with one job:
- **Welcome** — what's coming (from `steps`), a time estimate, `Let's go`.
- **You** — `Your name` (pre-filled), `TimezonePicker` (pre-filled with `session.user.timezone ?? guessTimezone()`), the live local time, and for an invited person the line "…entered this when inviting you. Change it if it's not quite right."
- **Secure** — `startEnrolment()` on mount, `<QrCode>` plus the key in `<code>`, `OtpInput` labelled `6-digit code`, `Verify` (disabled until six digits), then the recovery codes with `Copy all` / `Download .txt` and a required "I've saved these" before `Continue`.
- **Look** — three theme tiles as a `radiogroup`; choosing one sets `document.documentElement.dataset.theme` immediately (live preview through the glass) and stores the choice for `save()`.
- **Day** — day chips (`aria-pressed`), `From` / `To` / `Morning digest` times, and a `data-testid="day-preview"` sentence built by a tiny pure helper `dayPreview(days, start, end, digest)` in `apps/web/src/lib/day-preview.ts` with its own unit test (Mon–Fri collapses to "Monday to Friday"; otherwise the short names join with commas; "no days yet" when empty).
- **Alerts** — the achievement-sound switch with a volume slider and a `Play` sample (uses the existing `sound` lib), plus the three alert switches; admins also see a read-only "Security alerts · always on" row.
- **Team** — `listPeople()` and `listRoles()` on mount; the people list with role chips and "Invite sent" for pending ones; an invite row (`Email`, name derived from the address but editable, role select defaulting to Sales) calling `invite()`; a byline "…already invited N people" when someone else did.
- **Pipeline** — `listPipeline()` on mount; each stage with a colour dot, an inline-editable name (rename on blur via `renameStage`), and Move up / Move down buttons (keyboard-friendly; `reorderStages` on change); a byline when another admin already reviewed it.
- **Connect** — `ConnectCards`: Google Calendar for everyone (official `google-calendar.svg`, a Google-styled `Connect` button) and Google Sheets for admins (official `google-sheets.svg`), each showing its live state ("Connected by …", "Syncing"). While a capability is false the card is not rendered at all, so nothing ever offers a dead button.
- **Done** — the tick that springs in, a summary of what was set, and the two buttons.

`onboarding.module.css` carries the approved look: the glass sheet (`backdrop-filter: blur(30px) saturate(180%)`, the bright top edge, `--shadow-pop`), the rail on `--glass-rail`, one panel visible at a time with the `SPRINGS.default` slide-and-fade, the aura drifting behind, and the app behind blurred with `filter: blur(7px)` which animates away on finish. With `prefers-reduced-motion` the panel change is a cross-fade and the blur is static.

- [ ] **Step 5: Add the official brand files**

Download Google's official product marks (Calendar, Sheets) and the Google "G" from Google's brand resources into `apps/web/public/brand/`, unmodified, and record where each came from in `apps/web/public/brand/README.md`. Never recolour or redraw them; never inline them into CSS.

- [ ] **Step 6: Run to verify**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/web && pnpm --filter @lume/web typecheck'`
Expected: Onboarding (9) and day-preview (1) pass with the rest.

- [ ] **Step 7: Strict gate, commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(web): first-sign-in onboarding — glass sheet over the app, step rail, required 2FA enrolment, preferences, team and pipeline review

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 7: The spotlight product tour

**Files:**
- Create: `apps/web/src/components/tour/{TourProvider,Spotlight,TourCard}.tsx`, `apps/web/src/components/tour/tour.module.css`, `apps/web/src/components/tour/Tour.test.tsx`, `apps/web/src/lib/spotlight.ts`, `apps/web/src/lib/spotlight.test.ts`, `apps/web/src/lib/tour-client.ts`
- Modify: `apps/web/src/components/shell/AppShell.tsx`, `apps/web/src/app/(app)/today/page.tsx`, `apps/web/src/app/(app)/settings/page.tsx`, `apps/web/src/components/shell/Sidebar.tsx`

**Interfaces:**
- Consumes: `tourStepsFor`, `TOUR_VERSION`, `boldParts` (Task 1), `getSession()` (Task 2), `PUT /api/v1/me/tour`.
- Produces:
  - `clipPathFor(rect: DOMRectLike, pad: number, radius: number, viewport: { width: number; height: number }): string` — the `path(evenodd, …)` string that cuts the hole
  - `cardPosition(rect, placement, card: { width: number; height: number }, viewport): { top: number; left: number }`
  - `<TourProvider session steps autoStart>` with `useTour()` → `{ start(): void; active: boolean }`
  - `tourClient = { saveStep(step: number): Promise<void>; complete(): Promise<void>; skip(): Promise<void> }`
  - Every tour target exists as `data-tour="<target>"` in the shell

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/spotlight.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { cardPosition, clipPathFor } from "./spotlight";

const viewport = { width: 1000, height: 800 };

describe("spotlight geometry", () => {
  it("cuts an even-odd hole around the target, inside the viewport", () => {
    const p = clipPathFor({ top: 100, left: 50, width: 200, height: 40 }, 8, 14, viewport);
    expect(p.startsWith('path(evenodd,"M0 0H1000V800H0Z')).toBe(true);
    expect(p).toContain("M56 92"); // left+pad-radius … the hole starts after the outer rect
    expect(p.endsWith('Z")')).toBe(true);
  });

  it("never lets the hole leave the screen", () => {
    const p = clipPathFor({ top: -20, left: -30, width: 100, height: 50 }, 8, 14, viewport);
    expect(p).not.toMatch(/-\d/);
  });

  it("puts the card beside a sidebar target and below a top-bar target", () => {
    const card = { width: 330, height: 180 };
    expect(cardPosition({ top: 120, left: 10, width: 200, height: 34 }, "right", card, viewport)).toEqual({
      top: 108,
      left: 228,
    });
    expect(cardPosition({ top: 20, left: 600, width: 200, height: 34 }, "bottom", card, viewport)).toEqual({
      top: 70,
      left: 535,
    });
  });

  it("flips a card that would fall off the edge back inside", () => {
    const card = { width: 330, height: 180 };
    const pos = cardPosition({ top: 700, left: 900, width: 80, height: 34 }, "bottom", card, viewport);
    expect(pos.top + card.height).toBeLessThanOrEqual(viewport.height);
    expect(pos.left + card.width).toBeLessThanOrEqual(viewport.width);
  });
});
```

`apps/web/src/components/tour/Tour.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TOUR_STEPS } from "@lume/core";
import { fakeSession } from "@/server/session";
import { TourProvider } from "./TourProvider";

const targets = (ids: string[]) => (
  <>
    {ids.map((id) => (
      <button key={id} data-tour={id}>
        {id}
      </button>
    ))}
  </>
);
const client = () => ({ saveStep: vi.fn(async () => {}), complete: vi.fn(async () => {}), skip: vi.fn(async () => {}) });

describe("the spotlight tour", () => {
  it("walks the steps, bolding module names, and records where it got to", async () => {
    const c = client();
    const session = fakeSession({ permissions: [{ key: "leads.view", scope: "own" }] });
    render(
      <TourProvider session={session} client={c} autoStart>
        {targets(["brand", "nav-today", "nav-leads", "search", "notifications", "nav-settings", "profile"])}
      </TourProvider>,
    );
    const dialog = await screen.findByRole("dialog", { name: /tour/i });
    expect(dialog).toHaveTextContent("This is LUME");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(dialog).toHaveTextContent("Start on Today");
    expect(dialog.querySelector("strong")).toHaveTextContent("Today"); // bold, and not HTML from the string
    expect(c.saveStep).toHaveBeenCalledWith(1);
    await userEvent.keyboard("{ArrowLeft}");
    expect(dialog).toHaveTextContent("This is LUME");
  });

  it("finishes at the end and never asks again", async () => {
    const c = client();
    render(
      <TourProvider session={fakeSession({ permissions: [] })} client={c} autoStart>
        {targets(["brand", "nav-today", "search", "notifications", "nav-settings", "profile"])}
      </TourProvider>,
    );
    const total = TOUR_STEPS.filter((s) => s.permission === null && !s.needsCapability).length;
    for (let i = 0; i < total - 1; i++) await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(c.complete).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /tour/i })).not.toBeInTheDocument();
  });

  it("records a skip when Escape is pressed", async () => {
    const c = client();
    render(
      <TourProvider session={fakeSession({ permissions: [] })} client={c} autoStart>
        {targets(["brand", "nav-today", "search", "notifications", "nav-settings", "profile"])}
      </TourProvider>,
    );
    await screen.findByRole("dialog", { name: /tour/i });
    await userEvent.keyboard("{Escape}");
    expect(c.skip).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /tour/i })).not.toBeInTheDocument();
  });

  it("skips a step whose target is missing instead of pointing at nothing", async () => {
    render(
      <TourProvider session={fakeSession({ permissions: [] })} client={client()} autoStart>
        {targets(["brand", "search", "notifications", "nav-settings", "profile"])}
      </TourProvider>,
    );
    const dialog = await screen.findByRole("dialog", { name: /tour/i });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(dialog).not.toHaveTextContent("Start on Today"); // nav-today isn't rendered here
    expect(dialog).toHaveTextContent("Jump anywhere");
  });

  it("does not start on its own when the person has already seen it", async () => {
    render(
      <TourProvider
        session={fakeSession({ tour: { version: 1, step: 3, completedAt: "2026-09-20T10:00:00Z", skippedAt: null } })}
        client={client()}
        autoStart
      >
        {targets(["brand"])}
      </TourProvider>,
    );
    expect(screen.queryByRole("dialog", { name: /tour/i })).not.toBeInTheDocument();
  });
});
```

Add to `apps/web/src/components/shell/Sidebar.test.tsx` an integrity check, so a refactor can't silently break the tour:
```tsx
it("renders a target for every tour step (spec §5)", () => {
  render(
    <AppShell session={fakeSession({ permissions: ALL_PERMISSIONS })} businessName="Nupuur Coaching" theme="porcelain">
      <div />
    </AppShell>,
  );
  for (const target of new Set(TOUR_STEPS.map((s) => s.target))) {
    expect(document.querySelector(`[data-tour="${target}"]`), `missing data-tour="${target}"`).not.toBeNull();
  }
});
```
with `const ALL_PERMISSIONS = PERMISSIONS.map((p) => ({ key: p.key, scope: p.scoped ? ("all" as const) : null }));`.

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run apps/web/src/lib/spotlight.test.ts apps/web/src/components/tour apps/web/src/components/shell`
Expected: FAIL, modules not found and no `data-tour` attributes yet.

- [ ] **Step 3: Implement the geometry**

`apps/web/src/lib/spotlight.ts`:
```ts
export type RectLike = { top: number; left: number; width: number; height: number };
export type Viewport = { width: number; height: number };
const CARD_GAP = 16;
const EDGE = 12;
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * A blurred veil with a rounded hole: one `path(evenodd, …)` of the whole viewport plus the hole, so the
 * highlighted element stays perfectly sharp while everything else is blurred (spec §5).
 */
export function clipPathFor(rect: RectLike, pad: number, radius: number, vp: Viewport): string {
  const x = clamp(rect.left - pad, 0, vp.width);
  const y = clamp(rect.top - pad, 0, vp.height);
  const w = clamp(rect.left + rect.width + pad, 0, vp.width) - x;
  const h = clamp(rect.top + rect.height + pad, 0, vp.height) - y;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const n = (v: number) => Math.round(v);
  const hole =
    `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}` +
    `V${n(y + h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}` +
    `H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}` +
    `V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`;
  return `path(evenodd,"M0 0H${vp.width}V${vp.height}H0Z ${hole}")`;
}

/** Beside the target for sidebar items, below it for top-bar items, always fully on screen. */
export function cardPosition(
  rect: RectLike,
  placement: "right" | "bottom",
  card: { width: number; height: number },
  vp: Viewport,
): { top: number; left: number } {
  if (placement === "right") {
    const left = rect.left + rect.width + CARD_GAP + 2;
    return {
      top: clamp(rect.top - 12, EDGE, Math.max(EDGE, vp.height - card.height - EDGE)),
      left: left + card.width > vp.width - EDGE ? Math.max(EDGE, rect.left - card.width - CARD_GAP) : left,
    };
  }
  const below = rect.top + rect.height + CARD_GAP;
  const top = below + card.height > vp.height - EDGE ? Math.max(EDGE, rect.top - card.height - CARD_GAP) : below;
  return {
    top,
    left: clamp(rect.left + rect.width / 2 - card.width / 2, EDGE, Math.max(EDGE, vp.width - card.width - EDGE)),
  };
}
```

- [ ] **Step 4: Implement the tour**

`apps/web/src/lib/tour-client.ts`:
```ts
"use client";
import { api } from "./api";

export const tourClient = {
  async saveStep(step: number) {
    await api.put("/api/v1/me/tour", { step });
  },
  async complete() {
    await api.put("/api/v1/me/tour", { completed: true });
  },
  async skip() {
    await api.put("/api/v1/me/tour", { skipped: true });
  },
};
```

`TourProvider` (client):
- `steps = tourStepsFor(session.actor, session.capabilities)`, then filtered to those whose `data-tour` target is actually in the document (a missing target is skipped, never pointed at).
- Starts automatically when `autoStart` and `needsTour(session.tour)`; also starts from `useTour().start()` (Settings and the profile menu) and from `?tour=1` (how onboarding hands over).
- Tracks the target's rectangle with `getBoundingClientRect()`, re-measuring on `resize` and `scroll` (passive), and scrolls a target into view before measuring.
- Renders `<Spotlight>` (the veil with `clipPathFor`, plus the accent ring) and `<TourCard>` (`role="dialog"`, `aria-label="LUME tour"`, `aria-modal="false"` so the app stays readable, focus moved to the card on each step).
- Keyboard: `→`/`Enter` next, `←` back, `Escape` skip. Clicking the veil advances. `Next` becomes `Done` on the last step.
- `saveStep(i)` after each move, `complete()` on Done, `skip()` on Escape or Skip; the achievement chime plays once on Done.
- The card body renders `boldParts(step.body)` into text and `<strong>` runs, so module names are bold and nothing from the string is ever treated as HTML.
- With `prefers-reduced-motion`, the hole and card cross-fade instead of sliding, and the veil's blur is applied without transition.

`tour.module.css` holds the veil (`backdrop-filter: blur(9px) saturate(.92)` over `--veil`), the ring (`box-shadow: 0 0 0 2px var(--accent), 0 0 30px 6px rgba(42,91,255,.30)`), and the glass card, all with the approved springs. A `@supports not (clip-path: path("M0 0"))` fallback keeps a plain dim veil with the ring.

Wiring: `AppShell` renders `<TourProvider session={session} client={tourClient} autoStart>{…}</TourProvider>` inside its shell, and adds the `data-tour` attributes listed in Task 2. The Settings placeholder page gains a "Help" card with a `Replay the tour` button (calls `useTour().start()`), and the sidebar profile row gains the same item in its menu.

- [ ] **Step 5: Run to verify**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/web && pnpm --filter @lume/web typecheck'`
Expected: spotlight (4), Tour (5) and the shell integrity test pass with the rest.

- [ ] **Step 6: Strict gate, commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "feat(web): spotlight product tour — blurred veil with a sharp cut-out, bold module names, permission-built steps, replayable

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 8: End-to-end against the real stack (API + web), accessibility and visual baselines

**Files:**
- Create: `apps/web/e2e/{edge.mjs,smtp-sink.mjs,api-server.mjs,db.ts,global-setup.ts,fixtures.ts,seed.setup.ts}`
- Create: `apps/web/e2e/{setup.spec.ts,onboarding.spec.ts,tour.spec.ts,auth.spec.ts}`
- Modify: `apps/web/playwright.config.ts`, `apps/web/e2e/{a11y.spec.ts,visual.spec.ts,shell.spec.ts,settle.ts}`, `.github/workflows/ci.yml`, `apps/web/package.json`

**Interfaces:**
- Consumes: everything built in Tasks 1–7; `@lume/db`'s `migrate`, `installQueueSchema`, `roleUrl`, `adminUrl`; `QUEUE_NAMES` from `@lume/core`.
- Produces:
  - `resetE2eDatabase(): Promise<{ appUrl: string; ownerUrl: string }>` — creates `lume_e2e` if missing, migrates it, installs the queue schema, truncates every table
  - `readSetupToken(): Promise<string>` — reads the token the API printed into `e2e/.artifacts/api.log`
  - `lastMailTo(email: string): Promise<{ subject: string; text: string }>` — from the SMTP sink's HTTP endpoint
  - storage states `e2e/.artifacts/{owner,admin,rep}.json`
  - Playwright projects `setup-wizard` → `seed` → `app`, all behind an edge proxy on `127.0.0.1:3100` so the browser sees one origin exactly as Caddy serves it

- [ ] **Step 1: The three little servers**

`apps/web/e2e/edge.mjs` — mirrors Caddy so cookies and CSRF behave exactly as in production:
```js
// One origin for the browser: /api/* → the API, everything else → Next. Mirrors infra/Caddyfile.
import { createServer } from "node:http";
import { request } from "node:http";

const API = Number(process.env.E2E_API_PORT ?? 3101);
const WEB = Number(process.env.E2E_WEB_PORT ?? 3102);
const PORT = Number(process.env.E2E_EDGE_PORT ?? 3100);

createServer((req, res) => {
  const toApi = req.url.startsWith("/api/") || req.url === "/healthz" || req.url === "/readyz";
  const proxied = request(
    { host: "127.0.0.1", port: toApi ? API : WEB, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  proxied.on("error", () => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("upstream unavailable");
  });
  req.pipe(proxied);
}).listen(PORT, "127.0.0.1", () => console.log(`edge on ${PORT} → api ${API} / web ${WEB}`));
```

`apps/web/e2e/smtp-sink.mjs` — a minimal SMTP server so invite and reset emails are really sent and readable:
```js
// Minimal SMTP sink (RFC 5321 happy path only) + a tiny HTTP API to read what arrived.
import { createServer as createTcp } from "node:net";
import { createServer as createHttp } from "node:http";

const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 3110);
const HTTP_PORT = Number(process.env.E2E_MAIL_API_PORT ?? 3111);
const messages = [];

createTcp((socket) => {
  let buffer = "";
  let data = null;
  let to = [];
  const send = (line) => socket.write(`${line}\r\n`);
  send("220 lume-e2e sink");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let nl = buffer.indexOf("\r\n"); nl !== -1; nl = buffer.indexOf("\r\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      if (data !== null) {
        if (line === ".") {
          const text = data.join("\n");
          const subject = /^Subject: (.*)$/im.exec(text)?.[1] ?? "";
          messages.push({ to, subject, text, at: new Date().toISOString() });
          data = null;
          to = [];
          send("250 OK");
        } else data.push(line.startsWith("..") ? line.slice(1) : line);
        continue;
      }
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO") || upper.startsWith("HELO")) send("250 lume-e2e");
      else if (upper.startsWith("MAIL FROM")) send("250 OK");
      else if (upper.startsWith("RCPT TO")) {
        to.push(/<(.+)>/.exec(line)?.[1] ?? line.slice(8).trim());
        send("250 OK");
      } else if (upper === "DATA") {
        data = [];
        send("354 End with .");
      } else if (upper === "QUIT") {
        send("221 Bye");
        socket.end();
      } else if (upper === "RSET") {
        to = [];
        send("250 OK");
      } else send("250 OK");
    }
  });
  socket.on("error", () => socket.destroy());
}).listen(SMTP_PORT, "127.0.0.1");

createHttp((req, res) => {
  if (req.url === "/messages") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(messages));
    return;
  }
  if (req.method === "DELETE" && req.url === "/messages") {
    messages.length = 0;
    res.writeHead(204).end();
    return;
  }
  res.writeHead(404).end();
}).listen(HTTP_PORT, "127.0.0.1", () => console.log(`smtp sink on ${SMTP_PORT}, api on ${HTTP_PORT}`));
```

`apps/web/e2e/api-server.mjs` — builds the API's env from the test database credentials and keeps its log where the tests can read the setup token:
```js
// Starts the real API against the e2e database, logging to e2e/.artifacts/api.log so tests can read
// the first-run setup token exactly as an operator would.
import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const admin = new URL(process.env.TEST_DATABASE_URL ?? "");
if (!admin.hostname) throw new Error("TEST_DATABASE_URL is required (scripts/dev.sh test-db up writes it)");
const appPw = process.env.TEST_PW_LUME_APP;
if (!appPw) throw new Error("TEST_PW_LUME_APP is required");
const dbUrl = `postgres://lume_app:${encodeURIComponent(appPw)}@${admin.hostname}:${admin.port}/lume_e2e`;

mkdirSync(path.join(import.meta.dirname, ".artifacts"), { recursive: true });
const log = createWriteStream(path.join(import.meta.dirname, ".artifacts/api.log"), { flags: "w" });

const child = spawn(process.execPath, [path.join(root, "apps/api/dist/main.js")], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
    API_PORT: process.env.E2E_API_PORT ?? "3101",
    DATABASE_URL_APP: dbUrl,
    LUME_PUBLIC_HOST: "127.0.0.1",
    LUME_PUBLIC_URL: `http://127.0.0.1:${process.env.E2E_EDGE_PORT ?? 3100}`,
    LUME_MASTER_KEY: Buffer.alloc(32, 5).toString("base64"),
    SMTP_URL: `smtp://127.0.0.1:${process.env.E2E_SMTP_PORT ?? 3110}`,
    MAIL_FROM: "LUME <no-reply@lume.test>",
    BREACHED_LIST_FILE: path.join(root, "packages/core/data/breached-sha1.bin"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(log);
child.stderr.pipe(log);
child.stdout.pipe(process.stdout);
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code ?? 0));
```

- [ ] **Step 2: Database reset and helpers**

`apps/web/e2e/db.ts`:
```ts
import pg from "pg";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, adminUrl, installQueueSchema, migrate } from "@lume/db";

const DB = "lume_e2e";
/** Everything the app writes; audit_log cannot be truncated (it is append-only by design). */
const TABLES = [
  "settings",
  "users",
  "roles",
  "role_permissions",
  "user_roles",
  "teams",
  "team_members",
  "sessions",
  "recovery_codes",
  "user_invites",
  "password_resets",
  "auth_throttle",
  "idempotency_keys",
  "reveal_counters",
  "lead_contact_keys",
  "activities",
  "lead_assignment_history",
  "lead_stage_history",
  "lead_tags",
  "leads",
  "role_field_access",
  "products",
  "tags",
  "lost_reasons",
  "field_definitions",
  "stages",
  "pipelines",
];

const urlFor = (role: string, password: string) => {
  const u = new URL(adminUrl());
  u.username = role;
  u.password = password;
  u.pathname = `/${DB}`;
  return u.toString();
};

/** A fresh installation for the browser tests: migrated, empty, and with no users so /setup works. */
export async function resetE2eDatabase(): Promise<{ ownerUrl: string }> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB]);
  if (!rowCount) {
    await admin.query(`CREATE DATABASE ${DB} OWNER lume_owner`);
    await admin.query(`REVOKE ALL ON DATABASE ${DB} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${DB} TO lume_app, lume_worker, lume_readonly_backup`);
  }
  await admin.end();

  const ownerUrl = urlFor("lume_owner", process.env.TEST_PW_LUME_OWNER!);
  await installQueueSchema(ownerUrl, QUEUE_NAMES);
  await migrate(ownerUrl, MIGRATIONS_DIR_DEFAULT);

  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const present = await owner.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
    [TABLES],
  );
  if (present.rowCount) await owner.query(`TRUNCATE ${present.rows.map((r) => r.table_name).join(", ")}`);
  await owner.end();
  return { ownerUrl };
}
```

`apps/web/e2e/fixtures.ts`:
```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test as base, expect, type APIRequestContext } from "@playwright/test";

const ARTIFACTS = path.resolve(import.meta.dirname, ".artifacts");
export const stateFile = (who: "owner" | "admin" | "rep") => path.join(ARTIFACTS, `${who}.json`);

/** The token the API printed at boot, read the way an operator reads it: from the log. */
export async function readSetupToken(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const log = await readFile(path.join(ARTIFACTS, "api.log"), "utf8").catch(() => "");
    const token = /setup token: ([A-Za-z0-9_-]+)/.exec(log)?.[1];
    if (token) return token;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the API never printed a setup token");
}

export type Mail = { to: string[]; subject: string; text: string; at: string };
const MAIL_API = `http://127.0.0.1:${process.env.E2E_MAIL_API_PORT ?? 3111}`;

export async function lastMailTo(request: APIRequestContext, email: string): Promise<Mail> {
  for (let i = 0; i < 60; i++) {
    const all = (await (await request.get(`${MAIL_API}/messages`)).json()) as Mail[];
    const mine = all.filter((m) => m.to.includes(email)).at(-1);
    if (mine) return mine;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no mail arrived for ${email}`);
}

export const linkIn = (mail: Mail, kind: "invite" | "reset"): string => {
  const m = new RegExp(`http[^\\s]*/${kind}/([A-Za-z0-9_-]{43})`).exec(mail.text);
  if (!m) throw new Error(`no ${kind} link in that email`);
  return `/${kind}/${m[1]}`;
};

export const test = base;
export { expect };
```

`apps/web/e2e/global-setup.ts`:
```ts
import { resetE2eDatabase } from "./db";

/** One fresh installation per run, so the setup wizard is genuinely a first run. */
export default async function globalSetup() {
  await resetE2eDatabase();
}
```

- [ ] **Step 3: Playwright configuration**

`apps/web/playwright.config.ts`:
```ts
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { stateFile } from "./e2e/fixtures";

const EDGE = 3100;
const root = path.resolve(import.meta.dirname, "../..");
const base = { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 800 } };

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.GITHUB_ACTIONS ? [["github"], ["list"]] : "list",
  expect: { toHaveScreenshot: { maxDiffPixels: 100, animations: "disabled" } },
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${EDGE}`, reducedMotion: "reduce", ...base },
  projects: [
    // The wizard needs an installation with no users, so it runs first and leaves the owner signed in.
    { name: "setup-wizard", testMatch: /setup\.spec\.ts/, use: base },
    // Then the people every other spec needs, created through the API and saved as storage states.
    { name: "seed", testMatch: /seed\.setup\.ts/, dependencies: ["setup-wizard"], use: { ...base, storageState: stateFile("owner") } },
    { name: "app", testIgnore: [/setup\.spec\.ts/, /seed\.setup\.ts/], dependencies: ["seed"], use: { ...base, storageState: stateFile("owner") } },
  ],
  webServer: [
    { command: "node e2e/smtp-sink.mjs", url: `http://127.0.0.1:${process.env.E2E_MAIL_API_PORT ?? 3111}/messages`, reuseExistingServer: false, timeout: 30_000 },
    {
      command: `pnpm --filter @lume/api build && node e2e/api-server.mjs`,
      cwd: root,
      url: `http://127.0.0.1:3101/healthz`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { E2E_API_PORT: "3101", E2E_EDGE_PORT: String(EDGE) },
    },
    {
      command: "pnpm build && pnpm start -p 3102 -H 127.0.0.1",
      url: "http://127.0.0.1:3102/sign-in",
      reuseExistingServer: false,
      timeout: 240_000,
      env: { LUME_API_URL: "http://127.0.0.1:3101", NEXT_TELEMETRY_DISABLED: "1", LUME_DESIGN_SHOWCASE: "1" },
    },
    { command: "node e2e/edge.mjs", url: `http://127.0.0.1:${EDGE}/sign-in`, reuseExistingServer: false, timeout: 30_000 },
  ],
});
```
(The API webServer's `cwd` is the repo root because its build script lives there; `e2e/api-server.mjs` resolves paths itself.)

- [ ] **Step 4: Write the failing flows**

`apps/web/e2e/setup.spec.ts`:
```ts
import { expect, readSetupToken, stateFile, test } from "./fixtures";

test("@smoke first run: the wizard creates the business and the owner, with two-step sign-in", async ({ page }) => {
  const token = await readSetupToken();
  await page.goto("/setup");

  await page.getByLabel("Setup token").fill(token);
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Business name").fill("Nupuur Coaching");
  await page.getByLabel("Timezone").fill("Dubai");
  await page.getByRole("option", { name: /Dubai/ }).first().click();
  await page.getByRole("radio", { name: /Coaching/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Your name").fill("Nupuur Patil");
  await page.getByLabel("Email").fill("owner@nupuur.test");
  await page.getByLabel("Password").fill("a long and lovely passphrase");
  await page.getByRole("button", { name: "Continue" }).click();

  // The secret is shown for anyone who can't scan; the test uses it to produce a real code.
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  const { totp } = await import("./totp");
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page.getByTestId("recovery-codes").getByRole("listitem")).toHaveCount(10);
  await page.getByRole("checkbox", { name: /saved/i }).check();
  await page.getByRole("button", { name: /open lume/i }).click();

  // Straight into onboarding, already signed in.
  await expect(page).toHaveURL(/\/welcome$/);
  await page.context().storageState({ path: stateFile("owner") });
});
```
`apps/web/e2e/totp.ts` is a three-line helper reusing the core implementation: `export { totpCode as totp } from "@lume/core";`.

`apps/web/e2e/seed.setup.ts` — creates the other two people through the API (fast, and it exercises the same endpoints the UI uses):
```ts
import { expect, lastMailTo, linkIn, stateFile, test } from "./fixtures";

test("seed an admin and a sales rep", async ({ page, request, browser }) => {
  // The owner is signed in (storage state from the wizard). Finish their onboarding so /today is reachable.
  await page.goto("/welcome");
  await page.getByRole("button", { name: /let’s go/i }).click();
  for (;;) {
    const explore = page.getByRole("button", { name: /explore on my own/i });
    if (await explore.isVisible().catch(() => false)) break;
    await page.getByRole("button", { name: /^Skip$|^Later$/ }).first().click();
  }
  await page.getByRole("button", { name: /explore on my own/i }).click();
  await expect(page).toHaveURL(/\/today$/);
  await page.context().storageState({ path: stateFile("owner") });

  const csrf = (await (await request.get("/api/v1/auth/csrf")).json()) as { token: string };
  const headers = { "x-csrf-token": csrf.token, "content-type": "application/json" };
  const roles = (await (await request.get("/api/v1/roles")).json()) as { roles: { id: string; name: string }[] };
  const roleId = (name: string) => roles.roles.find((r) => r.name === name)!.id;

  for (const who of [
    { email: "tasneem@nupuur.test", name: "Tasneem Shaikh", role: "Admin", file: stateFile("admin") },
    { email: "riya@nupuur.test", name: "Riya Sharma", role: "Sales", file: stateFile("rep") },
  ]) {
    const invited = await request.post("/api/v1/invites", {
      headers,
      data: { email: who.email, name: who.name, roleIds: [roleId(who.role)] },
    });
    expect(invited.ok()).toBeTruthy();
    const link = linkIn(await lastMailTo(request, who.email), "invite");
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(link);
    await p.getByLabel("Choose a password").fill("sunrise over the creek at five");
    await p.getByRole("button", { name: "Join LUME" }).click();
    await expect(p).toHaveURL(/\/welcome$/);
    await ctx.storageState({ path: who.file });
    await ctx.close();
  }
});
```

`apps/web/e2e/onboarding.spec.ts`:
```ts
import { stateFile } from "./fixtures";
import { expect, test } from "./fixtures";

test.use({ storageState: stateFile("rep") });

test("@smoke a rep's onboarding saves their choices and hands over to the tour", async ({ page }) => {
  await page.goto("/welcome");
  await expect(page.getByRole("dialog", { name: /welcome to lume/i })).toBeVisible();
  await page.getByRole("button", { name: /let’s go/i }).click();

  await page.getByLabel("Your name").fill("Riya S");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("radio", { name: /obsidian/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "obsidian");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("button", { name: "Sat" }).click();
  await expect(page.getByTestId("day-preview")).toContainText("Sat");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("button", { name: "Continue" }).click(); // alerts, as they are
  await page.getByRole("button", { name: /take the tour/i }).click();

  await expect(page).toHaveURL(/\/today/);
  await expect(page.getByRole("dialog", { name: /tour/i })).toBeVisible();

  // Everything stuck: a reload lands in the app, not back in onboarding.
  await page.goto("/today");
  await expect(page.getByRole("dialog", { name: /welcome to lume/i })).toHaveCount(0);
  await expect(page.getByTestId("lockup")).toContainText("Nupuur Coaching");
});

test("an admin must set up two-step sign-in before the rest", async ({ page, context }) => {
  await context.clearCookies();
  await context.addCookies(JSON.parse(await (await import("node:fs/promises")).readFile(stateFile("admin"), "utf8")).cookies);
  await page.goto("/welcome");
  await page.getByRole("button", { name: /let’s go/i }).click();
  await page.getByRole("button", { name: "Continue" }).click(); // past You
  await expect(page.getByText(/authenticator/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip" })).toHaveCount(0);
  // Later steps stay locked until it is done.
  await expect(page.getByRole("navigation", { name: /steps/i }).getByRole("button", { name: "Alerts" })).toBeDisabled();
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  const { totp } = await import("./totp");
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByTestId("recovery-codes").getByRole("listitem")).toHaveCount(10);
});
```

`apps/web/e2e/tour.spec.ts`:
```ts
import { stateFile } from "./fixtures";
import { expect, test } from "./fixtures";

test.use({ storageState: stateFile("rep") });

test("@smoke the tour highlights one thing at a time and can be replayed", async ({ page }) => {
  await page.goto("/today?tour=1");
  const card = page.getByRole("dialog", { name: /tour/i });
  await expect(card).toContainText("This is LUME");
  const veil = page.getByTestId("tour-veil");
  await expect(veil).toBeVisible();

  await page.getByRole("button", { name: "Next" }).click();
  await expect(card).toContainText("Start on Today");
  await expect(card.locator("strong")).toHaveText("Today"); // module names read as names

  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("dialog", { name: /tour/i })).toHaveCount(0); // never nags again

  await page.goto("/settings");
  await page.getByRole("button", { name: /replay the tour/i }).click();
  await expect(page.getByRole("dialog", { name: /tour/i })).toContainText("This is LUME");
});

test("a rep is never shown admin-only steps", async ({ page }) => {
  await page.goto("/today?tour=1");
  const card = page.getByRole("dialog", { name: /tour/i });
  const seen: string[] = [];
  for (let i = 0; i < 30; i++) {
    seen.push(await card.getByRole("heading").innerText());
    const next = page.getByRole("button", { name: "Next" });
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click();
  }
  expect(seen.join(" | ")).not.toMatch(/People and roles|Audit log/);
});
```

`apps/web/e2e/auth.spec.ts`:
```ts
import { expect, lastMailTo, linkIn, stateFile, test } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

test("@smoke signing in, the wrong password, and the two-step code", async ({ page }) => {
  await page.goto("/today");
  await expect(page).toHaveURL(/\/sign-in/); // signed out is sent to the door

  await page.getByLabel("Email").fill("riya@nupuur.test");
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText(/don’t match/i);

  await page.getByLabel("Password").fill("sunrise over the creek at five");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/(today|welcome)/);
});

test("a reset email arrives and sets a new password", async ({ page, request }) => {
  await page.goto("/forgot");
  await page.getByLabel("Email").fill("riya@nupuur.test");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.getByText(/on its way/i)).toBeVisible();

  await page.goto(linkIn(await lastMailTo(request, "riya@nupuur.test"), "reset"));
  await page.getByLabel("New password").fill("password123456"); // on the breached list
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByRole("alert")).toContainText(/data breach/i);

  await page.getByLabel("New password").fill("a brand new quiet passphrase");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page).toHaveURL(/\/sign-in/);

  await page.getByLabel("Email").fill("riya@nupuur.test");
  await page.getByLabel("Password").fill("a brand new quiet passphrase");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/(today|welcome)/);
});

test("a used invite link explains itself instead of breaking", async ({ page }) => {
  await page.goto(`/invite/${"z".repeat(43)}`);
  await expect(page.getByText(/no longer valid/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
});
```
(The rep's password is changed by this spec, so `auth.spec.ts` runs after the others: give it `test.describe.configure({ mode: "serial" })` and name the file so it sorts last, or keep Playwright's default file order and put the rename in the plan's notes — the simplest reliable answer is that `seed.setup.ts` writes the rep's storage state *before* this spec runs, and storage states are cookies, not passwords, so nothing else depends on it.)

Extend `apps/web/e2e/a11y.spec.ts` with the new routes in both themes: `/sign-in`, `/forgot`, `/setup` (before the wizard is completed it redirects, so this one runs inside the `setup-wizard` project), `/welcome` (as the rep) and `/today` with the tour open. Extend `apps/web/e2e/visual.spec.ts` with screenshots of `/sign-in`, `/welcome` (first step, and the Look step), `/today` with the tour's first step, in both themes; plus **role snapshots** of `/today` as owner, admin and rep.

- [ ] **Step 5: Run the suite**

Run: `scripts/dev.sh test-db up` then `scripts/dev.sh run bash -c 'pnpm --filter @lume/web e2e'`
Expected: every spec passes. Debug anything that fails with superpowers:systematic-debugging — reproduce, find the cause, fix the cause (never loosen an assertion to make it pass).

- [ ] **Step 6: CI**

In `.github/workflows/ci.yml`'s `e2e` job: keep the test-db step, add `pnpm --filter @lume/api build` before Playwright (the config also builds it, so this is only a cache warm), pass `TEST_DATABASE_URL` and `TEST_PW_*` through to the container, and upload `apps/web/e2e/.artifacts/api.log` plus the Playwright report as artifacts on failure. Add `apps/web/e2e/.artifacts/` to `.gitignore`.

- [ ] **Step 7: Strict gate, commit and push**

```bash
scripts/dev.sh fmt
git add -A && git commit -m "test(web): end-to-end against the real API behind an edge proxy, with an SMTP sink, role snapshots and axe on every new route

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

---

### Task 9: Live acceptance on the dev stack

- [ ] **Step 1: Bring the stack up with the new web environment**

Run:
```bash
scripts/dev.sh up
scripts/dev.sh logs api | grep "first-run setup token"
```
Expected: healthy stack, migration `0011` applied, and a setup token printed (the dev database was reset at the end of 1B, so this is a genuine first run).

- [ ] **Step 2: Walk it in a real browser**

Run `scripts/dev.sh tunnel`, then in the browser at `https://lume.localhost:8443`:

1. `/setup` — paste the token, create **Nupuur Coaching** (Asia/Dubai, AED, AE, Coaching preset) and the owner with two-step sign-in; save the recovery codes.
2. Onboarding as the owner — set the theme, working day and alerts; invite Tasneem as **Admin** and Riya as **Sales**; check the pipeline stages; finish and take the tour.
3. The tour — step through it, confirm the blur and the single sharp highlight, then replay it from **Settings**.
4. Read both invite emails in Mailpit (`http://127.0.0.1:8025`), accept Tasneem's invite in a private window: her onboarding must require two-step sign-in before anything else.
5. As Riya, confirm her tour has no admin steps and her nav has no Settings-only areas.
6. Sign out, use **Forgot your password?**, read the email, set a new password, sign in with it.

Capture one screenshot per numbered step into `docs/runbooks/screenshots-1c1/` (PNG, both themes for the tour step).

- [ ] **Step 3: Record it**

Append a "Phase 1C-1" section to `docs/runbooks/acceptance.md` with: the steps above and their outcome, the CI run URL, the number of Playwright specs and axe checks, and a note that the dev database is left **as set up** this time (so 1C-2 can build on real data) with the owner's credentials stored only in the operator's password manager, never in the repo.

```bash
git add -A && git commit -m "docs: Phase 1C-1 acceptance on the dev stack

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 4: Update the progress memory**

Rewrite `lume-progress` memory: 1C-1 done (what it delivers), next 1C-2 (leads screens), and the reminder that the dev stack now holds a real installation.

---

## Self-review (2026-09-24)

**Spec coverage.** §3 architecture → Task 2. §4.1 onboarding flow → Tasks 1 (step list) and 6 (screens). §4.2 data → Task 1. §4.3 code-defined steps → Task 1. §5 tour → Tasks 1 and 7. §2's 1C-1 acceptance row → Tasks 8 and 9. §8 quality bars → Task 8. Setup wizard, sign-in, 2FA, recovery, invite, reset (§2 "Getting in") → Tasks 3, 4, 5. Capability gating for Connect (§4.1) → Tasks 1 and 6. Scrollbar and sound rules → Global Constraints, applied in Tasks 6 and 7.

**Deliberate omissions.** The Connect step's cards are built but hidden until `CAPABILITIES` flips, which is why the Sheets and Calendar phases come next in the spec's order. The Settings pages themselves are 1C-3; 1C-1 only adds the Help card with "Replay the tour" to the existing placeholder page.

**Type consistency.** `OnboardingActions` in Task 6 matches `onboardingActions()` in the same task, and both use `PreferencesPatch` and `OnboardingStepId` from Task 1. `Session` (Task 2) is what Tasks 6 and 7 consume, including `capabilities` and `flags`. `AuthStep`, `SignInResult`, `ResetResult` and `AcceptResult` are defined once in Task 3 and reused by Task 4. `api.get` is added in Task 6 where it is first needed, and the GET path never sends an Idempotency-Key.

## Execution notes

**Task 5.**
- *QR encoder correctness.* The plan's structural tests (size, finder patterns) would pass for an encoder that no phone can read. During development the encoder was compared module-for-module with an independent implementation (node-qrcode, byte mode, level M, mask 0) for every length from 1 to 213 plus Unicode, and each matrix was rendered and decoded back with jsQR: 217 of 217 identical and readable. Neither library is a dependency; `qr.test.ts` pins one of those matrices as a golden, and also checks the timing patterns and the dark module.
- *Code entry.* The wizard uses the same six-box `OtpInput` as sign-in rather than a single field, so the two screens match. `OtpInput` gained optional `onChange` and `label` props, and `onComplete` is now optional, because setup submits with `Finish setup` instead of on the sixth digit. The tests type the code the way sign-in's tests do.
- *Timezones.* ICU still reports a few zones by their old ids (`Asia/Calcutta`), and it leaves out `UTC`. `timezones.ts` maps the renamed ids to their current names and adds `UTC`. Both kinds of id pass the API's `timezoneSchema`.
- *Test mock.* The `motion/react` mock now makes one component per tag. The earlier version made a new component type on every access, which remounted controlled inputs after each keystroke.
- *Extra files.* `TimezonePicker.module.css`. Two tests were added beyond the plan: the codes cannot be skipped, and the General preset plus Back both work.
