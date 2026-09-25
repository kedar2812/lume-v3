import type { FieldOption, FieldType, PhoneStatus } from "@lume/core/shared";

export type ContactView = { display: string; masked: boolean; status?: PhoneStatus };
export type LeadCan = {
  edit: boolean;
  move: boolean;
  reveal: boolean;
  assign: boolean;
  delete: boolean;
  message: boolean;
};

/** A lead as the API serializes it for this caller: hidden fields are absent, contacts may be masked. */
export type Lead = {
  id: string;
  version: number;
  pipelineId: string;
  stageId?: string;
  ownerId?: string | null;
  name?: string;
  phone?: ContactView | null;
  email?: ContactView | null;
  instagram?: ContactView | null;
  value?: number | null;
  currency?: string | null;
  productId?: string | null;
  /** Where the lead came in from (an intake source); null when someone added it in LUME. */
  sourceId?: string | null;
  lostReasonId?: string | null;
  lostNote?: string | null;
  wonAt?: string | null;
  lostAt?: string | null;
  leadCreatedAt?: string | null;
  lastActivityAt?: string | null;
  stageEnteredAt?: string;
  createdAt: string;
  updatedAt: string;
  tagIds: string[];
  custom: Record<string, unknown>;
  contactMasked: boolean;
  can: LeadCan;
};
export type LeadPage = { items: Lead[]; nextCursor: string | null };

export type Stage = {
  id: string;
  name: string;
  color: string;
  position: number;
  kind: "open" | "won" | "lost";
  requiredFieldIds: string[];
};
export type Pipeline = { id: string; name: string; isDefault: boolean; stages: Stage[] };
export type FieldDefView = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: FieldOption[];
  isCore: boolean;
  isRequired: boolean;
  archived: boolean;
  access: "edit" | "view" | "hidden";
};
export type Person = { id: string; name: string; active: boolean };
export type Tag = { id: string; label: string; color: string };
export type LostReason = { id: string; label: string; position: number };
export type Product = { id: string; name: string; defaultValue: number | null; currency: string | null };

/** Everything the leads screens look things up in, loaded once per page. */
export type Catalog = {
  pipelines: Pipeline[];
  fields: FieldDefView[];
  people: Person[];
  tags: Tag[];
  lostReasons: LostReason[];
  products: Product[];
  /** The business currency (settings), the default for new values. */
  currency: string;
  /** The business country (settings, ISO 3166 alpha-2): the phone picker's default. */
  country: string | null;
};

export type Activity = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  user: { id: string; name: string } | null;
};
export type ContactKind = "phone" | "email" | "instagram";
export type Duplicate =
  | { visible: true; leadId: string; name: string; ownerName: string | null; matchedOn: ContactKind[] }
  | { visible: false; matchedOn: ContactKind[] };
export type BulkAction =
  | { type: "stage"; stageId: string; lostReasonId?: string; lostNote?: string }
  | { type: "assign"; ownerId: string | null }
  | { type: "tags"; add?: string[]; remove?: string[] }
  | { type: "delete" };
export type BulkResult = { updated: string[]; skipped: { id: string; code: string }[] };
