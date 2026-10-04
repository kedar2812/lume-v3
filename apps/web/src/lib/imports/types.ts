import type {
  ColumnAnalysis,
  ColumnMap,
  DateOrder,
  Delimiter,
  Encoding,
  FileWarning,
  IntakeField,
  Issue,
  Mapping,
  OwnerRule,
  Rules,
  Transform,
} from "@lume/core/shared";

export type {
  ColumnAnalysis,
  ColumnMap,
  DateOrder,
  Delimiter,
  Encoding,
  FileWarning,
  IntakeField,
  Issue,
  Mapping,
  OwnerRule,
  Rules,
  Transform,
};

// The API's answers (apps/api/src/modules/imports): what the Import screens read.

export type ImportStatus =
  "draft" | "queued" | "running" | "cancelling" | "cancelled" | "stopped_access" | "failed" | "done";

export type Target = { key: string; label: string; group: "Contact" | "Lead" | "Custom" };

export type DraftView = {
  id: string;
  status: ImportStatus;
  fileName: string;
  fileBytes: number;
  encoding: Encoding;
  delimiter: Delimiter;
  headerRow: number;
  headers: string[];
  /** The first five rows as read. */
  sample: string[][];
  rowCount: number;
  fileWarnings: FileWarning[];
  mapping: Mapping;
  rules: Rules;
  targets: Target[];
  analysis: ColumnAnalysis[];
  /** Everything that stops Start, with the column it belongs to (null: the rules). */
  problems: Issue[];
  alreadyImported: { at: string; by: string | null } | null;
  choices: {
    pipelines: { id: string; name: string; isDefault: boolean }[];
    stages: { id: string; name: string; kind: "open" | "won" | "lost" }[];
    people: { id: string; name: string; email: string }[];
    fields: IntakeField[];
  };
  can: { assign: boolean; manageFields: boolean; manageTags: boolean };
};

export type Outcome = "create" | "merge" | "skip" | "error" | "empty";
export type PreviewRow = {
  rowNumber: number;
  outcome: Outcome;
  name: string | null;
  mergeInto:
    | { visible: true; leadId: string; name: string; ownerName: string | null }
    | { visible: false }
    | { row: number }
    | null;
  alsoMatches: number;
  problems: Issue[];
  warnings: Issue[];
};
export type PreviewResult = { rows: PreviewRow[]; summary: Record<Outcome, number>; scanned: number };

export type ImportCounts = {
  created: number;
  merged: number;
  skipped: number;
  empty: number;
  errors: number;
  warnings: number;
  nameFromContact: number;
  missingStageFields: number;
  phoneNeedsCountry: number;
};
export type ImportView = {
  id: string;
  status: ImportStatus;
  /** Of the leads it created, those with their own earlier enquiry date, and their span (a finished import). */
  dated?: { n: number; from: string; to: string } | null;
  fileName: string;
  rowCount: number;
  cursorRow: number;
  counts: ImportCounts;
  startedBy: { id: string; name: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  seenAt: string | null;
  stopReason: string | null;
  sourceId: string;
  /** Row detail is for whoever ran it, or someone who could see every lead's contact anyway. */
  canSeeRows: boolean;
  mine: boolean;
};

export type RowView = {
  rowNumber: number;
  result: "pending" | "created" | "merged" | "skipped" | "error";
  problems: Issue[];
  warnings: Issue[];
  lead: { visible: true; id: string; name: string } | { visible: false } | null;
  cells: string[] | null;
};
