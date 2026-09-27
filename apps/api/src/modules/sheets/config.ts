import type { Keyring } from "@lume/core";

/** Where a sheet source reads from (spec §4); sealed in lead_sources.config_enc, bound to the source's id. */
export type SheetConfig = {
  spreadsheetId: string;
  /** The tab's numeric id: stable when the tab is renamed. */
  sheetId: number;
  tabTitle: string;
  /** 1-based row of the header in the sheet. */
  headerRow: number;
  /** How LUME reads it: the server's service account, or a Google grant from Connect with Google (2B-2). */
  auth: "service_account" | "oauth";
  /** The refresh token, for auth "oauth"; it lives only here, encrypted with the rest. */
  grant?: string;
};
const context = (sourceId: string) => `sheet-source:${sourceId}`;
export const sealConfig = (k: Keyring, sourceId: string, c: SheetConfig): Buffer =>
  k.encrypt(JSON.stringify(c), context(sourceId));
export const openConfig = (k: Keyring, sourceId: string, blob: Buffer): SheetConfig =>
  JSON.parse(k.decrypt(blob, context(sourceId))) as SheetConfig;
