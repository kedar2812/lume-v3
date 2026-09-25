"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiResult } from "@/lib/api";
import { accessGone } from "@/lib/settings/access";

export type ResourceState = "loading" | "ready" | "access-changed" | "error";

/**
 * One Settings page's data. A plain 403 (no permission) — on load or on any save passed through `guard` — means the
 * person's access changed while the page was open (another admin edited their role): the page then
 * says so calmly instead of showing an error or a half-saved form (spec §7).
 */
export function useSettingsResource<T>(load: () => Promise<ApiResult<T>>, opts: { initial?: T } = {}) {
  const [data, setData] = useState<T | null>(opts.initial ?? null);
  const [state, setState] = useState<ResourceState>(opts.initial !== undefined ? "ready" : "loading");
  const loadRef = useRef(load);
  loadRef.current = load;
  const skip = useRef(opts.initial !== undefined);

  const guard = useCallback(<R>(r: ApiResult<R>): r is Extract<ApiResult<R>, { ok: true }> => {
    if (r.ok) return true;
    if (accessGone(r)) setState("access-changed");
    return false;
  }, []);

  const fetchNow = useCallback(async () => {
    const r = await loadRef.current();
    if (r.ok) {
      setData(r.data);
      setState("ready");
    } else setState(accessGone(r) ? "access-changed" : "error");
  }, []);

  useEffect(() => {
    if (skip.current) {
      skip.current = false;
      return;
    }
    void fetchNow();
  }, [fetchNow]);

  return { data, setData, state, guard, reload: () => void fetchNow() };
}
