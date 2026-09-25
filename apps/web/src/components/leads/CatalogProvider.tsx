"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { Catalog } from "@/lib/leads/types";

const Ctx = createContext<Catalog | null>(null);

/** The catalog (pipelines, fields, people, tags…) the leads screens look things up in, loaded once. */
export function CatalogProvider({ catalog, children }: { catalog: Catalog; children: ReactNode }) {
  return <Ctx.Provider value={catalog}>{children}</Ctx.Provider>;
}

export function useCatalog(): Catalog {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCatalog outside CatalogProvider");
  return c;
}
