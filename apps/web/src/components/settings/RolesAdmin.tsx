"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { ApiResult } from "@/lib/api";
import { tokenColor } from "@/lib/leads/colors";
import type { FieldDefView } from "@/lib/leads/types";
import { accessGone } from "@/lib/settings/access";
import { rolesClient, type PermissionDef, type Role } from "@/lib/settings/roles";
import { AccessChanged } from "./AccessChanged";
import { FieldAccess } from "./FieldAccess";
import { RoleMatrix } from "./RoleMatrix";
import s from "./settings.module.css";

type Tab = "can" | "fields";
type Note = { text: string; problem?: boolean } | null;
const people = (n: number) => (n === 0 ? "Nobody yet" : `${n} ${n === 1 ? "person" : "people"}`);

/**
 * Roles & access: the roles on the left, the one open on the right with what it can do and which fields
 * it sees. Roles can be made, duplicated, renamed, and deleted (moving the people who hold one first).
 */
export function RolesAdmin({
  roles: initial,
  catalog,
  fields,
}: {
  roles: Role[];
  catalog: PermissionDef[];
  fields: FieldDefView[];
}) {
  const [roles, setRoles] = useState(initial);
  const [openId, setOpenId] = useState(initial[0]?.id ?? null);
  const [tab, setTab] = useState<Tab>("can");
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<Note>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  if (forbidden) return <AccessChanged />;
  const open = roles.find((r) => r.id === openId) ?? null;

  const landed = <T,>(r: ApiResult<T>): r is Extract<ApiResult<T>, { ok: true }> => {
    if (r.ok) return true;
    if (accessGone(r)) setForbidden(true);
    else setNote({ text: r.message || "That couldn’t be saved.", problem: true });
    return false;
  };
  const replace = (role: Role) => setRoles((all) => all.map((r) => (r.id === role.id ? role : r)));
  const add = (role: Role) => {
    setRoles((all) => [...all, role].sort((a, b) => a.name.localeCompare(b.name)));
    setOpenId(role.id);
    setTab("can");
  };
  const freeName = (base: string) => {
    const taken = new Set(roles.map((r) => r.name.toLowerCase()));
    let name = `${base} copy`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} copy ${n}`;
    return name;
  };

  return (
    <div className={s.rolesLayout}>
      <div className={s.fieldList}>
        <ul className={s.listCard}>
          {roles.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className={s.fieldRow}
                aria-current={r.id === openId || undefined}
                onClick={() => {
                  setOpenId(r.id);
                  setRenaming(false);
                  setNote(null);
                }}
              >
                <span className={s.fieldRowName}>
                  <span className={s.swatch} style={{ background: tokenColor(r.color) }} aria-hidden />{" "}
                  {r.name}
                </span>
                <span className={s.fieldRowMeta}>{people(r.holders)}</span>
              </button>
            </li>
          ))}
        </ul>
        <form
          method="post"
          className={`${s.addRow} ${s.addTeam}`}
          onSubmit={async (e) => {
            e.preventDefault();
            const name = draft.trim();
            if (!name) return;
            const r = await rolesClient.create({ name, grants: [] });
            if (!landed(r)) return;
            add(r.data.role);
            setDraft("");
            setNote({ text: `${name} created. Tick what it can do.` });
          }}
        >
          <label htmlFor="new-role" className={s.srOnly}>
            New role
          </label>
          <input
            id="new-role"
            className={s.addInput}
            placeholder="New role…"
            maxLength={60}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!draft.trim()}>
            Add
          </Button>
        </form>
      </div>

      <div className={s.stack}>
        {note &&
          (note.problem ? (
            <p role="alert" className={s.problem}>
              {note.text}
            </p>
          ) : (
            <p role="status" className={s.saved}>
              {note.text}
            </p>
          ))}
        {open ? (
          <section className={s.panel} aria-labelledby="role-title">
            <div className={s.teamHead}>
              {renaming ? (
                <input
                  className={s.rename}
                  aria-label="Role name"
                  defaultValue={open.name}
                  autoFocus
                  maxLength={60}
                  onBlur={() => setRenaming(false)}
                  onKeyDown={async (e) => {
                    if (e.key === "Escape") setRenaming(false);
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const name = e.currentTarget.value.trim();
                    setRenaming(false);
                    if (!name || name === open.name) return;
                    const r = await rolesClient.patch(open.id, { name });
                    if (landed(r)) replace(r.data.role);
                  }}
                />
              ) : (
                <h2 id="role-title" className={s.panelTitle}>
                  {open.name}
                </h2>
              )}
              <span className={s.teamCount}>{people(open.holders)}</span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Rename ${open.name}`}
                onClick={() => setRenaming(true)}
              >
                Rename
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Duplicate ${open.name}`}
                onClick={async () => {
                  const r = await rolesClient.clone(open.id, freeName(open.name));
                  if (!landed(r)) return;
                  add(r.data.role);
                  setNote({ text: `${r.data.role.name} made from ${open.name}.` });
                }}
              >
                Duplicate
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete ${open.name}`}
                onClick={() => setDeleting(true)}
              >
                Delete
              </Button>
            </div>
            <div role="tablist" aria-label={`${open.name} settings`} className={s.tabs}>
              {(
                [
                  ["can", "What it can do"],
                  ["fields", "Fields"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`role-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls="role-tabpanel"
                  className={s.tab}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div
              id="role-tabpanel"
              role="tabpanel"
              aria-labelledby={`role-tab-${tab}`}
              className={s.panelBody}
            >
              {tab === "can" ? (
                <RoleMatrix
                  key={open.id}
                  role={open}
                  catalog={catalog}
                  onChange={replace}
                  onForbidden={() => setForbidden(true)}
                />
              ) : (
                <FieldAccess
                  key={open.id}
                  role={open}
                  fields={fields}
                  onChange={replace}
                  onForbidden={() => setForbidden(true)}
                />
              )}
            </div>
          </section>
        ) : (
          <p className={s.muted}>No roles yet. Add one on the left.</p>
        )}
      </div>

      {deleting && open && (
        <DeleteRole
          role={open}
          others={roles.filter((r) => r.id !== open.id)}
          onCancel={() => setDeleting(false)}
          onDelete={async (to) => {
            setDeleting(false);
            if (!landed(await rolesClient.remove(open.id, to ?? undefined))) return;
            const target = roles.find((r) => r.id === to);
            setRoles((all) =>
              all
                .filter((r) => r.id !== open.id)
                .map((r) => (r.id === to ? { ...r, holders: r.holders + open.holders } : r)),
            );
            setOpenId(roles.find((r) => r.id !== open.id)?.id ?? null);
            setNote({ text: `${open.name} deleted.${target ? ` Its people now have ${target.name}.` : ""}` });
          }}
        />
      )}
    </div>
  );
}

/** Deleting a role people hold asks which role they move to; an unheld role just asks to confirm. */
function DeleteRole({
  role,
  others,
  onCancel,
  onDelete,
}: {
  role: Role;
  others: Role[];
  onCancel: () => void;
  onDelete: (replacementId: string | null) => void;
}) {
  const [to, setTo] = useState("");
  const held = role.holders > 0;
  return (
    <Dialog label={`Delete ${role.name}?`} onClose={onCancel}>
      <h2 className={s.dialogTitle}>Delete {role.name}?</h2>
      {held ? (
        <div className={s.rateField}>
          <label htmlFor="role-to">Move its {people(role.holders)} to</label>
          <select id="role-to" className={s.dialogSelect} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose a role</option>
            {others.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className={s.dialogText}>Nobody holds it, so nothing else changes.</p>
      )}
      <div className={s.dialogActions}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" disabled={held && !to} onClick={() => onDelete(to || null)}>
          Delete role
        </Button>
      </div>
    </Dialog>
  );
}
