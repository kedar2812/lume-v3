"use client";
import { scopeOf } from "@lume/core/shared";
import { Popover } from "@/components/ui/Popover";
import { personName } from "@/lib/leads/format";
import type { Catalog, Lead } from "@/lib/leads/types";
import type { Session } from "@/server/session";
import s from "./drawer.module.css";

/**
 * Who handles this lead. People who may reassign get a menu of active colleagues; "Unassigned" only for
 * those who can see unassigned leads at all (the API refuses it otherwise).
 */
export function AssignMenu({
  lead,
  catalog,
  session,
  onAssign,
}: {
  lead: Lead;
  catalog: Catalog;
  session: Session;
  onAssign: (ownerId: string | null) => void;
}) {
  const name = personName(catalog, lead.ownerId);
  if (!lead.can.assign)
    return (
      <span className={s.ownerText}>
        <span className={s.srOnly}>Owner:</span> {name}
      </span>
    );
  const people = catalog.people.filter((p) => p.active);
  const unassignedAllowed = scopeOf(session.actor, "leads.assign") === "all";
  return (
    <Popover
      label="Hand this lead to"
      role="menu"
      triggerClassName={s.ownerBtn}
      trigger={
        <>
          <span className={s.srOnly}>Owner:</span> {name}
          <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden>
            <path
              d="M3 4.5 6 7.5l3-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </>
      }
    >
      {(close) => (
        <ul className={s.menu}>
          {people.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                role="menuitem"
                aria-current={p.id === lead.ownerId || undefined}
                disabled={p.id === lead.ownerId}
                onClick={() => {
                  close();
                  onAssign(p.id);
                }}
              >
                {p.name}
                {p.id === lead.ownerId && <span aria-hidden> ✓</span>}
              </button>
            </li>
          ))}
          {unassignedAllowed && (
            <li>
              <button
                type="button"
                role="menuitem"
                disabled={lead.ownerId === null}
                onClick={() => {
                  close();
                  onAssign(null);
                }}
              >
                Unassigned
              </button>
            </li>
          )}
        </ul>
      )}
    </Popover>
  );
}
