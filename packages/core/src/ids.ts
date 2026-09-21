import { v7 } from "uuid";

/** Time-sortable UUID v7 (report §4.3). Postgres 17 has no native v7, so ids are minted in the app. */
export const newId = (): string => v7();
