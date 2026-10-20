/** What one job may take. The API keeps files of at most 25 MB; a little over that leaves room for nothing else. */
export type Limits = {
  /** The most a request body may be. */
  bytes: number;
  /** The most any one tool may run. */
  seconds: number;
  /** The most a tool may print (page counts, lengths): more is a file trying something. */
  maxOut: number;
  /** The most a PDF made from an Office file may be. */
  pdfBytes: number;
  /** The longest side of a thumbnail. */
  longest: number;
  /** Jobs running or waiting; one more is told to come back later (503). */
  queue: number;
};

const MB = 1024 * 1024;
export const LIMITS: Limits = {
  bytes: 26 * MB,
  seconds: 45,
  maxOut: 1 * MB,
  pdfBytes: 64 * MB,
  longest: 960,
  queue: 8,
};
