"use client";
import { useEffect, useState } from "react";
import { Popover } from "@/components/ui/Popover";
import { toViewFilters, type ListFilters } from "@/lib/leads/filters";
import type { Catalog } from "@/lib/leads/types";
import { viewsChanged, viewsClient, type RoleName, type ViewView } from "@/lib/views/client";
import { ViewForm } from "./ViewForm";
import s from "./views.module.css";

/**
 * Save view (4B), at the end of the filter bar: the filters as they stand, under a name. It grows from its
 * button; the name takes focus, Enter saves, and the new view arrives in the sidebar.
 */
export function SaveView({
  filters,
  canShare,
  onSaved,
}: {
  filters: ListFilters;
  catalog: Catalog;
  canShare: boolean;
  onSaved: (v: ViewView) => void;
}) {
  return (
    <Popover label="Save view" size="form" align="end" triggerClassName={s.saveBtn} trigger="Save view">
      {(close) => (
        <SaveBody
          canShare={canShare}
          onSave={async (v) => {
            const r = await viewsClient.create({
              name: v.name,
              color: v.color,
              filters: toViewFilters(filters),
              ...(v.sharedRoleIds.length ? { sharedRoleIds: v.sharedRoleIds } : {}),
            });
            if (!r.ok) return r.message;
            close();
            viewsChanged();
            onSaved(r.data);
            return null;
          }}
        />
      )}
    </Popover>
  );
}

function SaveBody({
  canShare,
  onSave,
}: {
  canShare: boolean;
  onSave: (v: { name: string; color: string; sharedRoleIds: string[] }) => Promise<string | null>;
}) {
  const [roles, setRoles] = useState<RoleName[] | null>(null);
  // The roles to share with come with the views list, for someone who may share.
  useEffect(() => {
    if (!canShare) return;
    let live = true;
    void viewsClient.list().then((r) => live && r.ok && setRoles(r.data.roles ?? []));
    return () => {
      live = false;
    };
  }, [canShare]);
  return <ViewForm canShare={canShare} roles={roles} onSubmit={onSave} />;
}
