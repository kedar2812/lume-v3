"use client";
import type { AnomalySettings, RuleId, WatermarkMode, WorkingHours } from "@lume/core/shared";
import { api } from "@/lib/api";

/** Settings → Security (6A): the API's shapes, as the screens read them. */
export type SecuritySettings = { anomaly: AnomalySettings; watermark: WatermarkMode };

export type Alert = {
  id: string;
  user: { id: string; name: string; initials: string };
  rule: RuleId;
  action: "alerted" | "suspended";
  observed: number;
  threshold: number;
  windowStart: string;
  windowEnd: string;
  status: "open" | "resolved";
  resolution: "restored" | "kept_suspended" | "offboarded" | "dismissed" | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export type AlertDetail = {
  alert: Alert;
  burst: { at: string; n: number }[];
  timeline: { at: string; words: string }[];
  person: { roles: string[]; joined: string | null; leadCount: number; usualPerDay: number };
  last30: { day: string; n: number }[];
};

export type LoginHours = { days: number[]; from: string; to: string; business?: true };
export type RoleAccess = {
  id: string;
  name: string;
  people: number;
  loginHours: LoginHours | null;
  ipAllowlist: string[] | null;
};
export type AccessView = {
  roles: RoleAccess[];
  workingHours: WorkingHours;
  timezone: string;
  yourIp: string;
};

export const securityClient = {
  settings: () => api.get<SecuritySettings>("/api/v1/security/settings"),
  saveSettings: (s: SecuritySettings) => api.put<SecuritySettings>("/api/v1/security/settings", s),
  alerts: (status: "open" | "recent" = "recent") =>
    api.get<{ alerts: Alert[] }>(`/api/v1/security/alerts?status=${status}`),
  alert: (id: string) => api.get<AlertDetail>(`/api/v1/security/alerts/${id}`),
  resolve: (id: string, resolution: "restored" | "kept_suspended" | "dismissed") =>
    api.post<{ alert: Alert }>(`/api/v1/security/alerts/${id}/resolve`, { resolution }),
  restorePerson: (userId: string) => api.post<void>(`/api/v1/security/people/${userId}/restore`),
  access: () => api.get<AccessView>("/api/v1/security/access"),
  saveAccess: (roleId: string, body: Pick<RoleAccess, "loginHours" | "ipAllowlist">) =>
    api.put<{ role: RoleAccess }>(`/api/v1/security/access/${roleId}`, body),
};

/** The rule's sentence, as the Rules page and the alerts say it ("More than 30 contacts opened in an hour"). */
export function ruleSentence(rule: RuleId, threshold: number): string {
  if (rule === "reveals") return `More than ${threshold} contacts opened in an hour`;
  if (rule === "leadsOpened") return `More than ${threshold} different leads opened in an hour`;
  return `More than ${threshold} WhatsApp send-queue runs in a day`;
}

/** What one alert says happened, in a line: "Rory Reid opened 34 contacts in 52 minutes". */
export function alertSentence(
  a: Pick<Alert, "user" | "rule" | "observed" | "windowStart" | "windowEnd">,
): string {
  const minutes = Math.max(1, Math.round((Date.parse(a.windowEnd) - Date.parse(a.windowStart)) / 60_000));
  const span = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  if (a.rule === "reveals") return `${a.user.name} opened ${a.observed} contacts in ${span}`;
  if (a.rule === "leadsOpened") return `${a.user.name} opened ${a.observed} different leads in ${span}`;
  return `${a.user.name} ran ${a.observed} send queues today`;
}
