/**
 * Storage (plan 2026-11-23-storage-clean-up): the kinds of file a clean-up can clear, the months a "closed" clean-up
 * may look back, and sizes and counts as the Storage page says them. Shared by the API and the web.
 */
export const CLEAN_KINDS = ["closed", "trash", "previews", "library", "old"] as const;
export type CleanKind = (typeof CLEAN_KINDS)[number];
/** How long ago a lead was won or lost before its files may go. */
export const CLOSED_MONTHS = [3, 6, 12, 24] as const;
export type ClosedMonths = (typeof CLOSED_MONTHS)[number];
export const DEFAULT_CLOSED_MONTHS: ClosedMonths = 6;
/** A preview not opened in this long can go: opening the file makes it again. */
export const PREVIEW_IDLE_DAYS = 90;
/** "Every chat file older than": the one clean-up that reaches open leads, never ticked unless asked. */
export const OLD_FILE_MONTHS = 12;
/** When the admins are told the disk is filling (a share of the disk). */
export const WARN_AT = [70, 80, 90] as const;
export type WarnAt = (typeof WARN_AT)[number];
export const DEFAULT_WARN_AT: WarnAt = 80;

const MB = 1024 * 1024;
const GB = 1024 * MB;
/**
 * A size on the Storage page: whole megabytes below a gigabyte ("830 MB"), one decimal from there ("20.7 GB"), so a
 * clean-up's "20.7 GB back" adds up with the rows it came from; a disk's size from 100 GB is whole ("500 GB").
 * Anything that isn't a size reads as 0 MB.
 */
export function storageSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes < GB) {
    const mb = Math.round(bytes / MB);
    return mb >= 1024 ? "1.0 GB" : `${Math.max(mb, bytes > 0 ? 1 : 0)} MB`;
  }
  const gb = bytes / GB;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return gb >= 99.95 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

const COUNT = new Intl.NumberFormat("en-IN");
/** A count as the page says it, in Indian grouping ("12,410", "12,34,567"). */
export const storageCount = (n: number): string => COUNT.format(Math.max(0, Math.round(n || 0)));
