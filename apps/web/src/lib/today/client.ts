"use client";
import { api } from "@/lib/api";
import type { Tiles } from "./types";

export const todayClient = {
  tiles: () => api.get<Tiles>("/api/v1/today/tiles"),
};
