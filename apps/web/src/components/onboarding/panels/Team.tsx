"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import type { OnboardingActions, Person } from "@/lib/onboarding-client";
import s from "../onboarding.module.css";
import { PanelHead } from "./Head";

/** "aman.verma@x.com" → "Aman Verma": a good first guess the person can correct. */
export const nameFromEmail = (email: string): string =>
  (email.split("@")[0] ?? "")
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function TeamPanel({
  kicker,
  actions,
  isOwner,
}: {
  kicker: string;
  actions: Pick<OnboardingActions, "listPeople" | "listRoles" | "invite">;
  isOwner: boolean;
}) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [roleId, setRoleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([actions.listPeople(), actions.listRoles()]).then(([p, r]) => {
      if (!live) return;
      setPeople(p);
      setRoles(r);
      setRoleId((r.find((x) => x.name === "Sales") ?? r[0])?.id ?? "");
    });
    return () => {
      live = false;
    };
  }, [actions]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    const address = email.trim();
    const who = name.trim() || nameFromEmail(address);
    if (!EMAIL.test(address)) return setError("Enter the email address they’ll sign in with.");
    if (!roleId) return setError("There’s no role you can give yet. The owner can add one in Settings.");
    setBusy(true);
    setError(null);
    const r = await actions.invite(address, who, roleId);
    setBusy(false);
    if (!r.ok) return setError(r.message ?? "That invite didn’t go out. Try again.");
    const role = roles.find((x) => x.id === roleId)?.name ?? "";
    setPeople((p) => [
      ...(p ?? []),
      { id: `invited-${address}`, name: who, email: address, role, pending: true },
    ]);
    setEmail("");
    setName("");
    setNameTouched(false);
  }

  const pending = people?.filter((p) => p.pending).length ?? 0;
  return (
    <>
      <PanelHead
        kicker={kicker}
        title={isOwner ? "Bring your team in" : "Your team"}
        lead="Each person gets an email invite and their own sign-in. What they can see depends on the role you give them."
      />
      {!isOwner && pending > 0 && (
        <p className={s.byline}>
          {pending === 1 ? "1 person is" : `${pending} people are`} already invited. Add anyone missing.
        </p>
      )}
      <div className={s.people} aria-busy={people === null}>
        {people === null
          ? [0, 1].map((i) => (
              <div key={i} className={s.person}>
                <Skeleton width={28} height={28} radius={14} />
                <Skeleton width={160} height={10} />
              </div>
            ))
          : people.map((p) => (
              <div key={p.id} className={s.person}>
                <Avatar name={p.name} />
                <div className={s.personText}>
                  <b>{p.name}</b>
                  <span>{p.email}</span>
                </div>
                {p.pending && <span className={s.pending}>Invite sent</span>}
                <span className={s.role} data-role={p.role}>
                  {p.role}
                </span>
              </div>
            ))}
      </div>
      <form className={s.invite} onSubmit={invite} noValidate>
        <input
          aria-label="Email"
          type="email"
          placeholder="name@company.com"
          autoComplete="off"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (!nameTouched) setName(nameFromEmail(e.target.value));
          }}
        />
        <input
          aria-label="Name"
          placeholder="Name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
          }}
        />
        <select aria-label="Role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" loading={busy}>
          Invite
        </Button>
      </form>
      {error && (
        <p role="alert" className={s.alert}>
          {error}
        </p>
      )}
    </>
  );
}
