"use client";
import { useMemo, useState } from "react";
import { OtpInput } from "@/components/auth/OtpInput";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { PasswordInput } from "@/components/ui/PasswordInput";
import type { LeadsChoice } from "@/lib/settings/people";
import { rolesClient, type Role, type RolePeople } from "@/lib/settings/roles";
import d from "./delete-account.module.css";
import s from "./offboard.module.css";
import r from "./delete-role.module.css";
import { Option, Step } from "./OffboardSheet";

export type RolePerson = { id: string; name: string; isOwner: boolean; roleIds: string[] };
type Choice = RolePeople["to"];

const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * Delete a role (owner 2026-11-02; spec docs/superpowers/specs/2026-11-02-delete-account-and-role.md): the top of the
 * hierarchy. Who holds it, then what happens to them (another role, a new one made here as its copy, offboarded, or
 * their accounts deleted), where its invites, templates and views go, the password every time, and a button that
 * says exactly what it will do.
 */
export function DeleteRoleSheet({
  role,
  others,
  people,
  me,
  twoStep,
  onClose,
  onDeleted,
}: {
  role: Role;
  /** Every other role: where its people and uses may go. */
  others: Role[];
  /** Everyone active in LUME, with their roles: who holds this one, and who could take leads. */
  people: RolePerson[];
  /** The person deleting. */
  me: string;
  twoStep: boolean;
  onClose: () => void;
  onDeleted: (o: { movedTo: string | null; people: Choice | null; newName?: string }) => void;
}) {
  const holders = useMemo(() => people.filter((p) => p.roleIds.includes(role.id)), [people, role.id]);
  const staying = useMemo(() => people.filter((p) => !p.roleIds.includes(role.id)), [people, role.id]);
  const protectedHolder = holders.some((p) => p.isOwner || p.id === me);
  const used = role.uses.invites + role.uses.templates + role.uses.views > 0;

  const [choice, setChoice] = useState<Choice>("role");
  const [toRole, setToRole] = useState(others[0]?.id ?? "");
  const [newName, setNewName] = useState(`${role.name} (new)`);
  const [leadsTo, setLeadsTo] = useState<"none" | "person">("none");
  const [leadsPerson, setLeadsPerson] = useState(staying[0]?.id ?? "");
  const [usesTo, setUsesTo] = useState(others[0]?.id ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const goesToRole = holders.length > 0 && (choice === "role" || choice === "new");
  const needsUsesRole = used && !goesToRole;
  const target = others.find((x) => x.id === toRole);
  const ready =
    password.length > 0 &&
    (!twoStep || code.length === 6) &&
    (!holders.length ||
      (choice === "role" && !!toRole) ||
      (choice === "new" && newName.trim().length > 0) ||
      ((choice === "offboard" || choice === "delete") &&
        !protectedHolder &&
        (leadsTo === "none" || !!leadsPerson))) &&
    (!needsUsesRole || !!usesTo);

  const n = holders.length;
  const them = n === 1 ? first(holders[0]!.name) : plural(n, "person", "people");
  const action = !n
    ? `Delete ${role.name}`
    : choice === "role"
      ? `Delete ${role.name} and move ${them} to ${target?.name ?? "another role"}`
      : choice === "new"
        ? `Delete ${role.name} and move ${them} to ${newName.trim() || "the new role"}`
        : choice === "offboard"
          ? `Delete ${role.name} and offboard ${them}`
          : `Delete ${role.name} and ${n === 1 ? `${first(holders[0]!.name)}’s account` : `${plural(n, "account")}`}`;

  const go = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setProblem(null);
    const leads: LeadsChoice = leadsTo === "person" ? { to: "person", userId: leadsPerson } : { to: "none" };
    const peopleChoice: RolePeople | undefined = !n
      ? undefined
      : choice === "role"
        ? { to: "role", roleId: toRole }
        : choice === "new"
          ? { to: "new", name: newName.trim() }
          : { to: choice, leads };
    const res = await rolesClient.remove(role.id, {
      password,
      ...(twoStep ? { code } : {}),
      ...(peopleChoice ? { people: peopleChoice } : {}),
      ...(needsUsesRole ? { replacementRoleId: usesTo } : {}),
    });
    setBusy(false);
    if (!res.ok) return setProblem(res.message);
    onDeleted({
      movedTo: res.data?.movedTo ?? null,
      people: n ? choice : null,
      ...(choice === "new" ? { newName: newName.trim() } : {}),
    });
  };

  return (
    <Dialog label={`Delete ${role.name}`} onClose={busy ? () => undefined : onClose} width={640}>
      <div className={s.sheet}>
        <header className={s.head}>
          <span className={r.swatch} data-color={role.color} aria-hidden />
          <div>
            <h2 className={s.title}>Delete {role.name}</h2>
            <p className={s.sub}>
              {n
                ? `${plural(n, "person holds", "people hold")} it. Choose what happens to ${n === 1 ? "them" : "everyone"}; nothing changes until you press the button.`
                : "Nobody holds it."}
            </p>
            {n > 0 && (
              <ul className={r.faces} aria-label={`Who holds ${role.name}`}>
                {holders.slice(0, 8).map((p) => (
                  <li key={p.id} title={p.name}>
                    <Avatar name={p.name} size={28} />
                  </li>
                ))}
                {n > 8 && <li className={r.more}>+{n - 8}</li>}
              </ul>
            )}
          </div>
        </header>

        <ol className={s.steps}>
          {n > 0 && (
            <Step
              n={1}
              state="idle"
              title={`What happens to ${n === 1 ? first(holders[0]!.name) : "its people"}`}
            >
              <div
                role="radiogroup"
                aria-label={`What happens to the people in ${role.name}`}
                className={s.choices}
              >
                <Option
                  on={choice === "role"}
                  disabled={busy || !others.length}
                  onPick={() => setChoice("role")}
                  title="Move them to another role"
                  detail={choice === "role" ? "" : target ? `To ${target.name}` : ""}
                >
                  {choice === "role" && (
                    <select
                      aria-label="Role to move them to"
                      className={s.select}
                      value={toRole}
                      disabled={busy}
                      onChange={(e) => setToRole(e.target.value)}
                    >
                      {others.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Option>
                <Option
                  on={choice === "new"}
                  disabled={busy}
                  onPick={() => setChoice("new")}
                  title="Make a new role for them"
                  detail={`It starts as a copy of ${role.name}’s access; change it after`}
                >
                  {choice === "new" && (
                    <input
                      aria-label="New role’s name"
                      className={r.name}
                      value={newName}
                      maxLength={60}
                      disabled={busy}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                  )}
                </Option>
                <Option
                  on={choice === "offboard"}
                  disabled={busy || protectedHolder}
                  onPick={() => setChoice("offboard")}
                  title="Offboard them"
                  detail={
                    protectedHolder
                      ? "You or the owner hold this role: move them instead"
                      : "Signed out, leads handed on; they can be brought back later"
                  }
                />
                <Option
                  on={choice === "delete"}
                  disabled={busy || protectedHolder}
                  onPick={() => setChoice("delete")}
                  title={n === 1 ? "Delete their account" : "Delete their accounts"}
                  detail={
                    protectedHolder
                      ? "You or the owner hold this role: move them instead"
                      : "Gone for good; what they did stays on the record"
                  }
                />
              </div>
              {(choice === "offboard" || choice === "delete") && !protectedHolder && (
                <div className={r.leads}>
                  <span className={r.label}>Their leads</span>
                  <div className={r.leadRow}>
                    <select
                      aria-label="Who takes their leads"
                      className={s.select}
                      value={leadsTo === "none" ? "" : leadsPerson}
                      disabled={busy}
                      onChange={(e) => {
                        setLeadsTo(e.target.value ? "person" : "none");
                        if (e.target.value) setLeadsPerson(e.target.value);
                      }}
                    >
                      <option value="">Leave them unassigned</option>
                      {staying.map((p) => (
                        <option key={p.id} value={p.id}>
                          Give them to {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {choice === "delete" && (
                    <p className={d.warning}>
                      {n === 1 ? `${first(holders[0]!.name)}’s account is` : `${plural(n, "account")} are`}{" "}
                      deleted the moment you press the button, and LUME can’t bring {n === 1 ? "it" : "them"}{" "}
                      back.
                    </p>
                  )}
                </div>
              )}
            </Step>
          )}

          {needsUsesRole && (
            <Step n={n ? 2 : 1} state="idle" title="Where its invites, templates and views go">
              <select
                aria-label="Role for its invites, templates and views"
                className={s.select}
                value={usesTo}
                disabled={busy}
                onChange={(e) => setUsesTo(e.target.value)}
              >
                {others.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Step>
          )}

          <Step n={(n ? 1 : 0) + (needsUsesRole ? 1 : 0) + 1} state="idle" title="Your password">
            <div className={d.fields}>
              <label className={d.field}>
                <span>Password</span>
                <PasswordInput
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={busy}
                />
              </label>
              {twoStep && (
                <div className={d.field}>
                  <span>Your two-step code</span>
                  <OtpInput onChange={setCode} label="Two-step code" disabled={busy} />
                </div>
              )}
            </div>
          </Step>
        </ol>

        {problem && (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        )}

        <footer className={s.foot}>
          <span className={s.grow} />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={!ready} onClick={() => void go()}>
            {action}
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}
