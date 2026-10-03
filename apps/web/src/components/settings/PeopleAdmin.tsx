"use client";
import { useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import type { ApiResult } from "@/lib/api";
import { can } from "@lume/core/shared";
import { invitesClient, usersClient, type Invite, type RoleRef, type UserRow } from "@/lib/settings/people";
import { securityClient } from "@/lib/settings/security";
import type { Session } from "@/server/session";
import { accessGone } from "@/lib/settings/access";
import { shortDate } from "@/lib/settings/format";
import { timezoneOf } from "@/lib/tasks/format";
import { AccessChanged } from "./AccessChanged";
import { OffboardSheet } from "./OffboardSheet";
import s from "./settings.module.css";

type Note = { text: string; problem?: boolean; copy?: string } | null;
const day = (iso: string) => shortDate(iso, false);
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Everyone who uses LUME: invite someone with a role, follow invites until they're accepted, and change
 * a person's role, sign them out everywhere, or offboard them (6C: signed out, their leads handed on, their
 * calendar disconnected, in one act). The owner can't be changed from here, and nobody can offboard themselves.
 */
export function PeopleAdmin({
  users: initialUsers,
  invites: initialInvites,
  roles,
  session,
  offboard = null,
}: {
  users: UserRow[];
  invites: Invite[];
  /** The roles this admin may hand out (never more than they hold themselves). */
  roles: RoleRef[];
  session: Session;
  /** Someone to offboard on arrival (`?offboard=<id>`, from a security alert). */
  offboard?: string | null;
}) {
  const [users, setUsers] = useState(initialUsers);
  const [invites, setInvites] = useState(initialInvites);
  const [resent, setResent] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<Note>(null);
  const [forbidden, setForbidden] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [offboarding, setOffboarding] = useState<UserRow | null>(() => {
    const u = initialUsers.find((x) => x.id === offboard);
    return u && !u.isOwner && u.id !== session.user.id && u.status !== "disabled" ? u : null;
  });

  if (forbidden) return <AccessChanged />;

  const landed = <T,>(r: ApiResult<T>): r is Extract<ApiResult<T>, { ok: true }> => {
    if (r.ok) return true;
    if (accessGone(r)) setForbidden(true);
    else setNote({ text: r.message || "That didn’t work. Try again.", problem: true });
    return false;
  };

  return (
    <div className={s.stack}>
      <InviteForm
        roles={roles}
        onSend={async (input) => {
          setNote(null);
          const r = await invitesClient.create(input);
          if (!landed(r)) return false;
          setInvites((all) => [
            {
              id: r.data.invite.id,
              email: r.data.invite.email,
              name: input.name,
              roles: roles.filter((x) => input.roleIds.includes(x.id)),
              invitedBy: session.user.name,
              expiresAt: r.data.invite.expiresAt,
              expired: false,
            },
            ...all,
          ]);
          setNote({ text: `Invite sent to ${r.data.invite.email}.`, copy: r.data.url });
          return true;
        }}
      />

      {note &&
        (note.problem ? (
          <p role="alert" className={s.problem}>
            {note.text}
          </p>
        ) : (
          <p role="status" className={s.saved}>
            {note.text}
            {note.copy && <CopyLink url={note.copy} />}
          </p>
        ))}

      {invites.length > 0 && (
        <section className={s.panel} aria-labelledby="invites-title">
          <div className={s.panelHead}>
            <h2 id="invites-title" className={s.panelTitle}>
              Waiting to join
            </h2>
          </div>
          <ul className={s.peopleList}>
            {invites.map((inv) => (
              <li key={inv.id} className={s.personRow} data-asking={revoking === inv.id || undefined}>
                {revoking === inv.id ? (
                  <div className={s.ask} role="group" aria-label={`Revoke invite to ${inv.email}?`}>
                    <p>
                      <b>Revoke the invite to {inv.email}?</b> The link stops working at once.
                    </p>
                    <Button size="sm" variant="ghost" onClick={() => setRevoking(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        setRevoking(null);
                        if (landed(await invitesClient.revoke(inv.id))) {
                          setInvites((all) => all.filter((x) => x.id !== inv.id));
                          setNote({ text: `Invite to ${inv.email} revoked.` });
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                ) : (
                  <>
                    <Avatar name={inv.name} size={32} />
                    <div className={s.personText}>
                      <span className={s.personName}>{inv.name}</span>
                      <span className={s.personMeta}>
                        {inv.email}
                        {inv.roles.length > 0 && ` · ${inv.roles.map((x) => x.name).join(", ")}`}
                      </span>
                    </div>
                    <span
                      className={s.inviteState}
                      data-expired={(inv.expired && !resent.has(inv.id)) || undefined}
                    >
                      {resent.has(inv.id)
                        ? "New link sent"
                        : inv.expired
                          ? "Link expired"
                          : `Expires ${day(inv.expiresAt)}`}
                    </span>
                    <div className={s.personActions}>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Resend invite to ${inv.email}`}
                        onClick={async () => {
                          if (!landed(await invitesClient.resend(inv.id))) return;
                          setResent((r) => new Set(r).add(inv.id));
                          setNote({ text: `New link sent to ${inv.email}. The old one no longer works.` });
                        }}
                      >
                        Resend
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Revoke invite to ${inv.email}`}
                        onClick={() => setRevoking(inv.id)}
                      >
                        Revoke
                      </Button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={s.panel} aria-labelledby="people-title">
        <div className={s.panelHead}>
          <h2 id="people-title" className={s.panelTitle}>
            People
          </h2>
        </div>
        {users.length === 0 ? (
          <p className={`${s.muted} ${s.panelBody}`}>Nobody else yet. Invite your team above.</p>
        ) : (
          <ul className={s.peopleList}>
            {users.map((u) => {
              const locked = u.isOwner || u.id === session.user.id;
              const off = u.status === "disabled";
              // Paused by the watch (6A): restored in Security, or here by someone who manages it.
              const paused = u.status === "suspended";
              return (
                <li key={u.id} className={s.personRow} data-off={off || undefined}>
                  <Avatar name={u.name} size={32} />
                  <div className={s.personText}>
                    <span className={s.personName}>
                      {u.name}
                      {u.id === session.user.id && <span className={s.you}> · you</span>}
                    </span>
                    <span className={s.personMeta}>
                      {u.email} · {u.lastLoginAt ? `last in ${day(u.lastLoginAt)}` : "hasn’t signed in yet"}
                    </span>
                  </div>
                  <span className={s.chips}>
                    {u.isOwner && <span className={s.chip}>Owner</span>}
                    {off && (
                      <span className={s.chip} data-tone="danger">
                        Disabled
                      </span>
                    )}
                    {paused && (
                      <span className={s.chip} data-tone="danger" title="LUME paused their access">
                        Paused
                      </span>
                    )}
                    {!u.twoFactor && !off && (
                      <span className={s.chip} data-tone="warn" title="Two-step sign-in is off">
                        No two-step
                      </span>
                    )}
                  </span>
                  {locked || off || roles.length === 0 ? (
                    <span className={s.roleText}>{u.roles.map((x) => x.name).join(", ") || "—"}</span>
                  ) : (
                    <select
                      className={s.roleSelect}
                      aria-label={`Role for ${u.name}`}
                      value={u.roles[0]?.id ?? ""}
                      onChange={async (e) => {
                        const before = users;
                        const role = roles.find((x) => x.id === e.target.value);
                        setUsers((all) =>
                          all.map((x) => (x.id === u.id ? { ...x, roles: role ? [role] : [] } : x)),
                        );
                        if (landed(await usersClient.setRoles(u.id, role ? [role.id] : [])))
                          setNote({ text: `${firstName(u.name)} is now ${role?.name ?? "without a role"}.` });
                        else setUsers(before);
                      }}
                    >
                      {!u.roles[0] && <option value="">No role</option>}
                      {roles.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className={s.personActions}>
                    {!locked && paused && can(session.actor, "security.manage") && (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Restore access for ${u.name}`}
                        onClick={async () => {
                          if (!landed(await securityClient.restorePerson(u.id))) return;
                          setUsers((all) => all.map((x) => (x.id === u.id ? { ...x, status: "active" } : x)));
                          setNote({ text: `${firstName(u.name)} can sign in again.` });
                        }}
                      >
                        Restore access
                      </Button>
                    )}
                    {!locked && !off && (
                      <>
                        {!paused && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Sign ${u.name} out everywhere`}
                            onClick={async () => {
                              if (landed(await usersClient.endSessions(u.id)))
                                setNote({ text: `${firstName(u.name)} is signed out everywhere.` });
                            }}
                          >
                            Sign out
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={`Offboard ${u.name}`}
                          onClick={() => setOffboarding(u)}
                        >
                          Offboard
                        </Button>
                      </>
                    )}
                    {!locked && off && (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Enable ${u.name}`}
                        onClick={async () => {
                          if (!landed(await usersClient.enable(u.id))) return;
                          setUsers((all) => all.map((x) => (x.id === u.id ? { ...x, status: "active" } : x)));
                          setNote({ text: `${firstName(u.name)} can sign in again.` });
                        }}
                      >
                        Enable
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {offboarding && (
        <OffboardSheet
          personId={offboarding.id}
          timeZone={timezoneOf(session.user.timezone)}
          onClose={() => setOffboarding(null)}
          onDone={(outcome) => {
            const who = offboarding;
            setOffboarding(null);
            setUsers((all) => all.map((x) => (x.id === who.id ? { ...x, status: "disabled" } : x)));
            setNote({
              text: `${firstName(who.name)} is offboarded.${outcome.leads.moved ? ` ${outcome.leads.moved.toLocaleString("en-US")} ${outcome.leads.moved === 1 ? "lead" : "leads"} handed on.` : ""}`,
            });
          }}
        />
      )}
    </div>
  );
}

function InviteForm({
  roles,
  onSend,
}: {
  roles: RoleRef[];
  onSend: (input: { email: string; name: string; roleIds: string[] }) => Promise<boolean>;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState(""); // chosen on purpose, never defaulted to the first (often Admin)
  const [errors, setErrors] = useState<{ email?: string; name?: string; role?: string }>({});
  const [busy, setBusy] = useState(false);

  return (
    <form
      method="post"
      noValidate
      className={s.panel}
      aria-labelledby="invite-title"
      onSubmit={async (e) => {
        e.preventDefault();
        const next = {
          email: EMAIL.test(email.trim()) ? undefined : "Enter an email address, like name@company.com",
          name: name.trim() ? undefined : "Add their name",
          role: roleId || roles.length === 0 ? undefined : "Choose what they can do",
        };
        setErrors(next);
        if (next.email || next.name || next.role) return;
        setBusy(true);
        const sent = await onSend({
          email: email.trim(),
          name: name.trim(),
          roleIds: roleId ? [roleId] : [],
        });
        setBusy(false);
        if (sent) {
          setEmail("");
          setName("");
          setRoleId("");
        }
      }}
    >
      <div className={s.panelHead}>
        <h2 id="invite-title" className={s.panelTitle}>
          Invite someone
        </h2>
        <p className={s.muted}>They get an email with a link to set their password. It works for 3 days.</p>
      </div>
      <div className={`${s.panelBody} ${s.inviteGrid}`}>
        <Field label="Email" error={errors.email}>
          {(control) => (
            <input
              {...control}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setErrors((x) => ({ ...x, email: undefined }));
              }}
            />
          )}
        </Field>
        <Field label="Name" error={errors.name}>
          {(control) => (
            <input
              {...control}
              autoComplete="off"
              value={name}
              maxLength={120}
              onChange={(e) => {
                setName(e.target.value);
                setErrors((x) => ({ ...x, name: undefined }));
              }}
            />
          )}
        </Field>
        <Field label="Role" error={errors.role}>
          {(control) => (
            <select
              {...control}
              value={roleId}
              onChange={(e) => {
                setRoleId(e.target.value);
                setErrors((x) => ({ ...x, role: undefined }));
              }}
            >
              <option value="" disabled={roles.length > 0}>
                {roles.length ? "Choose a role" : "No role"}
              </option>
              {roles.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className={s.panelFoot}>
        <Button type="submit" variant="primary" loading={busy}>
          Send invite
        </Button>
      </div>
    </form>
  );
}

/** Copies an invite link, for when the email might not arrive. */
function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={s.undo}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Link copied" : "Copy link"}
    </button>
  );
}
