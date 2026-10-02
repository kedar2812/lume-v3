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
  /** The business's first day of the week (0 = Sunday). */
  weekStart: number;
  yourIp: string;
};

/** One lead export (6B), as the Exports list shows it. */
export type ExportRow = {
  id: string;
  code: string;
  label: string;
  format: "csv" | "xlsx";
  rows: number;
  createdAt: string;
  expiresAt: string;
  available: boolean;
  downloads: number;
  who: { id: string; name: string; initials: string };
};
/** What Trace found (6B): whose export, when, what, every download, and how it was recognised. */
export type TraceMatch = {
  id: string;
  code: string;
  who: { id: string; name: string };
  createdAt: string;
  label: string;
  rows: number;
  format: "csv" | "xlsx";
  foundBy: "column" | "check_row";
  downloads: { at: string; device: string }[];
};

export const securityClient = {
  exports: () => api.get<{ exports: ExportRow[] }>("/api/v1/leads/exports"),
  traceFile: (file: File) => api.upload<{ match: TraceMatch | null }>("/api/v1/security/trace", file),
  traceCode: (code: string) => api.post<{ match: TraceMatch | null }>("/api/v1/security/trace", { code }),
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

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^(?=.*:)[0-9a-f:]{2,39}$/i;

/** An address or a network: "86.98.40.12", "94.200.12.0/24", "2001:db8::/32". The server checks it again. */
export function isNetwork(x: string): boolean {
  const [addr = "", bits, ...more] = x.trim().split("/");
  if (more.length) return false;
  const v4 = IPV4.test(addr);
  const v6 = !v4 && IPV6.test(addr) && (addr.match(/::/g)?.length ?? 0) <= 1;
  if (!v4 && !v6) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (v4 ? 32 : 128);
}

const v4Number = (a: string) => a.split(".").reduce((n, o) => n * 256 + Number(o), 0);

/** Whether this network holds that address (IPv4 by prefix; IPv6 when it names the very address). */
export function networkHolds(network: string, ip: string): boolean {
  const [addr = "", bits] = network.split("/");
  if (IPV4.test(addr) && IPV4.test(ip)) {
    const n = bits === undefined ? 32 : Number(bits);
    const mask = n === 0 ? 0 : 2 ** 32 - 2 ** (32 - n);
    return (v4Number(addr) & mask) >>> 0 === (v4Number(ip) & mask) >>> 0;
  }
  return addr.toLowerCase() === ip.toLowerCase() && (bits === undefined || bits === "128");
}
