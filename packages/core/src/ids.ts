import { v7 } from "uuid";

/** Time-sortable UUID v7 (report §4.3). Postgres 17 has no native v7, so ids are minted in the app. */
export const newId = (): string => v7();

/** A v7 id minted for a moment in the past (demo and backfilled history), so id order is still time order. */
export const idAt = (at: Date): string => v7({ msecs: at.getTime() });
