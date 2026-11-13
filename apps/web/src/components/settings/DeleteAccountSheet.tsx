"use client";
import { useEffect, useState } from "react";
import { OtpInput } from "@/components/auth/OtpInput";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { accountClient } from "@/lib/settings/account";
import { usersClient, type LeadsChoice, type OffboardPreview } from "@/lib/settings/people";
import { Option, sharesFor, Step } from "./OffboardSheet";
import s from "./offboard.module.css";
import d from "./delete-account.module.css";

const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;

type Choice = "team" | "person" | "none";

/**
 * Delete an account (owner 2026-11-02; spec docs/superpowers/specs/2026-11-02-delete-account-and-role.md): who takes the
 * leads, the password (twice, for your own; with two-step, the code), and a plain word that it can't be undone. Your
 * own from My account; someone else's from People, with your password.
 */
export function DeleteAccountSheet({
  self,
  personId,
  personName,
  twoStep,
  onClose,
  onDeleted,
}: {
  /** Your own account (My account) or someone else's (People). */
  self: boolean;
  personId: string;
  personName: string;
  /** The person confirming has two-step on: their code too. */
  twoStep: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [preview, setPreview] = useState<OffboardPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>("none");
  const [teamId, setTeamId] = useState("");
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (self ? accountClient.deletePreview() : usersClient.offboarding(personId)).then((r) => {
      if (!live) return;
      if (!r.ok) return setProblem(r.message);
      setPreview(r.data);
      setTeamId(r.data.teams[0]?.id ?? "");
      setUserId(r.data.people[0]?.id ?? "");
      setChoice(
        r.data.leads.total === 0
          ? "none"
          : r.data.teams.length
            ? "team"
            : r.data.people.length
              ? "person"
              : "none",
      );
    });
    return () => {
      live = false;
    };
  }, [self, personId]);

  const name = first(personName);
  const mismatch = self && again.length > 0 && again !== password;
  const ready = password.length > 0 && (!self || again === password) && (!twoStep || code.length === 6);
  const leadsOf = (p: OffboardPreview): LeadsChoice =>
    p.leads.total === 0 || choice === "none"
      ? { to: "none" }
      : choice === "team"
        ? { to: "team", teamId }
        : { to: "person", userId };

  const go = async () => {
    if (!preview || !ready || busy) return;
    setBusy(true);
    setProblem(null);
    const leads = leadsOf(preview);
    const extra = twoStep ? { code } : {};
    const r = self
      ? await accountClient.deleteMe({ leads, password, passwordAgain: again, ...extra })
      : await usersClient.deleteAccount(personId, { leads, password, ...extra });
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    onDeleted();
  };

  const title = self ? "Delete your account" : `Delete ${personName}’s account`;
  if (!preview)
    return (
      <Dialog label={title} onClose={onClose} wide>
        {problem ? (
          <>
            <p role="alert" className={s.problem}>
              {problem}
            </p>
            <div className={s.foot}>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <p className={s.loading} role="status">
            LUME is gathering what there is to hand on…
          </p>
        )}
      </Dialog>
    );

  const p = preview;
  const team = p.teams.find((t) => t.id === teamId) ?? p.teams[0];
  const shares = team ? sharesFor(team.members, p.leads.open, p.leads.total - p.leads.open) : [];
  const person = p.people.find((x) => x.id === userId);
  const whose = self ? "your" : `${name}’s`;

  return (
    <Dialog label={title} onClose={busy ? () => undefined : onClose} width={620}>
      <div className={s.sheet}>
        <header className={s.head}>
          <Avatar name={personName} size={44} />
          <div>
            <h2 className={s.title}>{title}</h2>
            <p className={s.sub}>
              {self
                ? "You’re signed out, and your name, email and password are gone from LUME."
                : `${name} is signed out, and their name, email and password are gone from LUME.`}{" "}
              What {self ? "you" : "they"} did stays on the record.
            </p>
          </div>
        </header>

        <ol className={s.steps}>
          <Step
            n={1}
            state="idle"
            title={
              p.leads.total
                ? `Who takes ${whose} ${plural(p.leads.total, "lead")}`
                : `${self ? "You have" : `${name} has`} no leads to hand on`
            }
          >
            {p.leads.total > 0 && (
              <div role="radiogroup" aria-label={`Who takes ${whose} leads`} className={s.choices}>
                {team && (
                  <Option
                    on={choice === "team"}
                    disabled={busy}
                    onPick={() => setChoice("team")}
                    title={`Share them across the ${team.name} team`}
                    detail="Whoever has the fewest open leads gets the next one"
                  >
                    {choice === "team" && (
                      <>
                        {p.teams.length > 1 && (
                          <select
                            aria-label="Team"
                            className={s.select}
                            value={team.id}
                            disabled={busy}
                            onChange={(e) => setTeamId(e.target.value)}
                          >
                            {p.teams.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                        )}
                        <span className={s.split} role="group" aria-label="Each person’s share">
                          {shares.map((x) => (
                            <span key={x.id}>
                              {x.name} · {x.count.toLocaleString("en-US")}
                            </span>
                          ))}
                        </span>
                      </>
                    )}
                  </Option>
                )}
                {p.people.length > 0 && (
                  <Option
                    on={choice === "person"}
                    disabled={busy}
                    onPick={() => setChoice("person")}
                    title="Give them all to one person"
                    detail={choice === "person" ? "" : (person?.name ?? "")}
                  >
                    {choice === "person" && (
                      <select
                        aria-label="Person"
                        className={s.select}
                        value={userId}
                        disabled={busy}
                        onChange={(e) => setUserId(e.target.value)}
                      >
                        {p.people.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </Option>
                )}
                <Option
                  on={choice === "none"}
                  disabled={busy}
                  onPick={() => setChoice("none")}
                  title="Leave them unassigned"
                  detail="An admin hands them out later"
                />
              </div>
            )}
          </Step>

          <Step n={2} state="idle" title={self ? "Your password, twice" : "Your password"}>
            <div className={d.fields}>
              <label className={d.field}>
                <span>{self ? "Password" : "Your password"}</span>
                <PasswordInput
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={busy}
                />
              </label>
              {self && (
                <label className={d.field}>
                  <span>The same password again</span>
                  <PasswordInput
                    value={again}
                    onChange={(e) => setAgain(e.target.value)}
                    autoComplete="current-password"
                    aria-invalid={mismatch || undefined}
                    disabled={busy}
                  />
                </label>
              )}
              {mismatch && (
                <p className={d.mismatch} role="alert">
                  The two passwords aren’t the same.
                </p>
              )}
              {twoStep && (
                <div className={d.field}>
                  <span>Your two-step code</span>
                  <OtpInput onChange={setCode} label="Two-step code" disabled={busy} />
                </div>
              )}
            </div>
          </Step>

          <Step n={3} state="idle" title="This can’t be undone">
            <p className={d.warning}>
              {self
                ? "Your account is deleted the moment you press the button, and LUME can’t bring it back. To use LUME again, you’d need a new invite."
                : `${name}’s account is deleted the moment you press the button, and LUME can’t bring it back. To come back, ${name} would need a new invite.`}
            </p>
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
            {self ? "Delete my account" : `Delete ${name}’s account`}
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}
