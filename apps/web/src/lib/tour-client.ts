"use client";
import { api } from "./api";

export type TourClient = {
  saveStep(step: number): Promise<void>;
  complete(): Promise<void>;
  skip(): Promise<void>;
};

/** Tour progress on the person's own record (PUT /me/tour). A failed save never interrupts the tour. */
export const tourClient: TourClient = {
  async saveStep(step) {
    await api.put("/api/v1/me/tour", { step });
  },
  async complete() {
    await api.put("/api/v1/me/tour", { completed: true });
  },
  async skip() {
    await api.put("/api/v1/me/tour", { skipped: true });
  },
};
