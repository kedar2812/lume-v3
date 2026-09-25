import { cache } from "react";
import { redirect } from "next/navigation";
import {
  EMPTY_ONBOARDING,
  EMPTY_TOUR,
  LEGAL_VERSION,
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
} from "@lume/core/shared";
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
  /** The licence agreement, terms and privacy policy: the version agreed to, and the current one. */
  agreement: { version: string | null; current: string };
  flags: {
    needsAgreement: boolean;
    needsOnboarding: boolean;
    needsTwoFactorEnrolment: boolean;
    needsTour: boolean;
  };
  /** The same Actor shape the API and core use, so gates call the very same `can()`. */
  actor: Actor;
};

/** Exactly what GET /auth/me sends. Permission keys stay loose here: a newer API may know more of them. */
export type MePayload = Omit<Session, "actor" | "permissions" | "agreement" | "flags"> & {
  permissions: { key: string; scope: Scope | null }[];
  /** Absent from an API that predates the agreement. */
  agreement?: Session["agreement"];
  flags: Omit<Session["flags"], "needsAgreement"> & { needsAgreement?: boolean };
};

export function toSession(me: MePayload): Session {
  const known = me.permissions.filter((p): p is { key: PermissionKey; scope: Scope | null } =>
    isPermissionKey(p.key),
  );
  return {
    user: me.user,
    permissions: known,
    twoFactor: me.twoFactor,
    preferences: me.preferences ?? PREFERENCES_DEFAULTS,
    onboarding: me.onboarding ?? EMPTY_ONBOARDING,
    tour: me.tour ?? EMPTY_TOUR,
    capabilities: me.capabilities,
    agreement: me.agreement ?? { version: null, current: LEGAL_VERSION },
    // An API from before the agreement existed sends no flag: nobody is asked.
    flags: { ...me.flags, needsAgreement: me.flags.needsAgreement ?? false },
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

/**
 * A session for tests and previews. Pass only what the test cares about; the actor is derived from the
 * permissions exactly as a real session's is.
 */
export function fakeSession(overrides: Partial<Omit<Session, "actor">> = {}): Session {
  const base: MePayload = {
    user: {
      id: "00000000-0000-7000-8000-000000000001",
      name: "Riya Sharma",
      email: "riya@example.test",
      isOwner: false,
      theme: "system",
      timezone: "Asia/Dubai",
    },
    permissions: [{ key: "leads.view", scope: "own" }],
    twoFactor: { enabled: true, required: false },
    preferences: PREFERENCES_DEFAULTS,
    onboarding: EMPTY_ONBOARDING,
    tour: EMPTY_TOUR,
    capabilities: { sheets: false, calendar: false },
    agreement: { version: LEGAL_VERSION, current: LEGAL_VERSION },
    flags: {
      needsAgreement: false,
      needsOnboarding: false,
      needsTwoFactorEnrolment: false,
      needsTour: false,
    },
  };
  return toSession({ ...base, ...overrides } as MePayload);
}
