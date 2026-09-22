export type FieldAccess = "hidden" | "view" | "edit";
const RANK: Record<FieldAccess, number> = { hidden: 0, view: 1, edit: 2 };

/**
 * Report §7.1 field-level access, unioned like permissions: for each field the widest access any of the
 * user's roles gives wins, and a role with no row for a field gives `edit`. Only fields that end up
 * narrower than `edit` are returned.
 */
export function mergeFieldAccess(
  roleIds: string[],
  rows: { roleId: string; fieldId: string; access: FieldAccess }[],
): Map<string, FieldAccess> {
  const perField = new Map<string, Map<string, FieldAccess>>();
  for (const r of rows) {
    if (!perField.has(r.fieldId)) perField.set(r.fieldId, new Map());
    perField.get(r.fieldId)!.set(r.roleId, r.access);
  }
  const out = new Map<string, FieldAccess>();
  for (const [fieldId, byRole] of perField) {
    let best: FieldAccess = "hidden";
    for (const roleId of roleIds) {
      const a = byRole.get(roleId) ?? "edit";
      if (RANK[a] > RANK[best]) best = a;
    }
    if (roleIds.length > 0 && best !== "edit") out.set(fieldId, best);
  }
  return out;
}

export const fieldAccessOf = (m: ReadonlyMap<string, FieldAccess>, fieldId: string): FieldAccess =>
  m.get(fieldId) ?? "edit";
export const FIELD_ACCESS_RANK = RANK;
