import type { Allow, AutopilotAction, LeadState, PauseReason, RunStatus } from "@lume/core/shared";

/** Autopilot as the API answers it (A2 read/start, A3 setup): each type mirrors one response. */

export type RunGoal =
  { kind: "stage"; stageId: string } | { kind: "reply" } | { kind: "brief"; text: string };
export type Permissions = Record<AutopilotAction, Allow>;
export type Available = { ok: true } | { ok: false; why: string; fixHref: string | null };
export type ReadyCode = "AI_OFF" | "AI_MONTH" | "REPLY_OFF" | "NO_NUMBER" | "NUMBER_QUALITY" | "NO_TEMPLATES";

/** `GET /api/v1/autopilot/setup`: what the start sheet opens with. */
export type AutopilotSetup = {
  ready: { ok: true } | { ok: false; code: ReadyCode; message: string; fixHref: string | null };
  goals: { kind: "stage"; stageId: string; name: string }[];
  speakers: { id: string; name: string }[];
  standing: {
    permissions: Permissions;
    followUpDays: number[];
    dailyCap: number | null;
    speaker: string | null;
  };
  available: Record<AutopilotAction, Available>;
  hours: { line: string };
  number: { display: string; tierLimit: number | "unlimited" | null } | null;
  canRemember: boolean;
};

/** "All that match" on Leads: the server resolves it as bulk actions do. */
export type RunSelection = { filters: Record<string, string>; except: string[]; expected: number };

/** What starting a run (or its estimate) sends. */
export type RunBody = ({ leadIds: string[] } | { selection: RunSelection }) & {
  goal: RunGoal;
  speakerId: string | null;
  permissions: Permissions;
  followUpDays: number[];
  dailyCap: number | null;
  name?: string;
  remember?: boolean;
};

export type Skipped = { leadId: string; why: string };
export type Estimate = {
  eligible: number;
  skipped: Skipped[];
  firstMessages: number;
  metaCost: { amount: number; currency: string } | null;
  monthShare: number | null;
};

export type RunView = {
  id: string;
  name: string;
  startedBy: string;
  speakerId: string;
  numberId: string;
  goal: RunGoal;
  permissions: Permissions;
  followUpDays: number[];
  dailyCap: number | null;
  outsideHours: "reply_any_time" | "wait";
  status: RunStatus;
  pauseReason: PauseReason | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
};
/** `leads`: how many the run took (some may have been skipped, or taken by another run, since the estimate). */
export type StartResult = { run: RunView; skipped: Skipped[]; remembered: boolean; leads: number };

export type Counts = Record<LeadState, number>;
export type RunLead = {
  leadId: string;
  name: string;
  state: LeadState;
  reason: string | null;
  card: { headline: string; quote: string | null } | null;
  thought: string | null;
  /** When the lead last wrote; null if they haven't. */
  repliedAt: string | null;
  /** Only while LUME AI is writing to this lead: the words and the window the screen reveals them in. */
  draft: {
    text: string;
    kind: "template" | "reply";
    templateName: string | null;
    startedAt: string;
    revealedBy: string;
    /** Where a template's filled values sit in `text`, `[start, end)`; none for a reply. */
    marks: [number, number][];
  } | null;
  nextAt: string | null;
  lastSentAt: string | null;
  updatedAt: string;
};
export type RunAsk = {
  id: string;
  leadId: string;
  action: AutopilotAction;
  payload: Record<string, unknown>;
  createdAt: string;
};
/** `GET /api/v1/autopilot/runs/:id`. */
export type RunDetail = {
  run: RunView & { canControl: boolean; speakerName: string };
  counts: Counts;
  leads: RunLead[];
  asks: RunAsk[];
};
/** `GET /api/v1/autopilot/runs`. */
export type RunsList = { runs: (RunView & { counts: Counts })[]; running: number };
