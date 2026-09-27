/** Spec §5.1. One place for every intake limit, so the API, the job and the screens agree. */
export const INTAKE_LIMITS = {
  bytes: 10_485_760,
  rows: 20_000,
  columns: 200,
  cellChars: 10_000,
  headerSearch: 10,
  previewRows: 20,
  batch: 200,
} as const;
