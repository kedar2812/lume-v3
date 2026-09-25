"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { OtpInput } from "@/components/auth/OtpInput";
import { QrCode } from "@/components/setup/QrCode";
import { RecoveryCodeList } from "@/components/setup/RecoveryCodes";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { accountClient, type MySession } from "@/lib/settings/account";
import { deviceName } from "@/lib/settings/device";
import { shortDateTime } from "@/lib/settings/format";
import type { Session } from "@/server/session";
import s from "./settings.module.css";

/**
 * The signed-in person's own account: their name and look, two-step sign-in (on, off where the role
 * allows it, and fresh recovery codes), and every device signed in, with a way to end the others.
 */
export function MyAccount({ session }: { session: Session }) {
  return (
    <div className={s.stack}>
      <Profile session={session} />
      <TwoStep session={session} />
      <Sessions />
    </div>
  );
}

function Block({ title, lede, children }: { title: string; lede?: string; children: ReactNode }) {
  const id = `acct-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section className={s.panel} aria-labelledby={id}>
      <div className={s.panelHead}>
        <h2 id={id} className={s.panelTitle}>
          {title}
        </h2>
        {lede && <p className={s.muted}>{lede}</p>}
      </div>
      <div className={s.panelBody}>{children}</div>
    </section>
  );
}

function Profile({ session }: { session: Session }) {
  const router = useRouter();
  const [name, setName] = useState(session.user.name);
  const [saved, setSaved] = useState(session.user.name);
  const [note, setNote] = useState<{ text: string; problem?: boolean } | null>(null);

  const save = async () => {
    const next = name.trim();
    if (!next) return setNote({ text: "Your name can’t be empty", problem: true });
    if (next === saved) return;
    const r = await accountClient.updateProfile({ name: next });
    if (!r.ok) return setNote({ text: r.message || "Your name couldn’t be saved.", problem: true });
    setSaved(next);
    setNote({ text: "Saved" });
    router.refresh(); // the name shows in the sidebar
  };

  return (
    <Block title="You" lede={session.user.email}>
      <div className={s.pair}>
        <Field label="Your name">
          {(control) => (
            <input
              {...control}
              value={name}
              maxLength={120}
              autoComplete="name"
              onChange={(e) => {
                setName(e.target.value);
                setNote(null);
              }}
              onBlur={() => void save()}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                void save();
              }}
            />
          )}
        </Field>
        <div className={s.lookField}>
          <span className={s.blockLabel}>Look</span>
          <ThemeToggle initial={session.user.theme} />
        </div>
      </div>
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
    </Block>
  );
}

type TwoStepState =
  | { kind: "idle" }
  | { kind: "password"; purpose: "codes" | "off"; busy: boolean; error: string | null }
  | {
      kind: "enrol";
      enrolment: { secret: string; otpauthUri: string } | null;
      error: string | null;
      key: number;
    }
  | { kind: "codes"; codes: string[]; fresh: "replaced" | "new"; saved: boolean };

function TwoStep({ session }: { session: Session }) {
  const router = useRouter();
  const [on, setOn] = useState(session.twoFactor.enabled);
  const [st, setSt] = useState<TwoStepState>({ kind: "idle" });
  const [password, setPassword] = useState("");

  const startEnrol = async () => {
    setSt({ kind: "enrol", enrolment: null, error: null, key: 0 });
    const r = await accountClient.beginTwoFactor();
    setSt(
      r.ok
        ? { kind: "enrol", enrolment: r.data, error: null, key: 0 }
        : { kind: "enrol", enrolment: null, error: r.message || "Two-step setup couldn’t start.", key: 0 },
    );
  };

  const confirmCode = async (code: string) => {
    if (code.length !== 6 || st.kind !== "enrol") return;
    const r = await accountClient.confirmTwoFactor(code);
    if (!r.ok)
      return setSt({
        ...st,
        error: r.message || "That code didn’t match. Try the newest one.",
        key: st.key + 1,
      });
    setOn(true);
    setSt({ kind: "codes", codes: r.data.recoveryCodes, fresh: "new", saved: false });
    router.refresh();
  };

  const withPassword = async () => {
    if (st.kind !== "password") return;
    setSt({ ...st, busy: true, error: null });
    if (st.purpose === "codes") {
      const r = await accountClient.newRecoveryCodes(password);
      if (!r.ok) return setSt({ ...st, busy: false, error: r.message || "That didn’t work." });
      setSt({ kind: "codes", codes: r.data.recoveryCodes, fresh: "replaced", saved: false });
    } else {
      const r = await accountClient.disableTwoFactor(password);
      if (!r.ok) return setSt({ ...st, busy: false, error: r.message || "That didn’t work." });
      setOn(false);
      setSt({ kind: "idle" });
      router.refresh();
    }
    setPassword("");
  };

  return (
    <Block
      title="Two-step sign-in"
      lede={
        on
          ? "On. Signing in asks for a code from your phone."
          : "Off. Turn it on so a stolen password alone can’t get into LUME."
      }
    >
      {st.kind === "idle" && (
        <div className={s.rowActions}>
          {on ? (
            <>
              <Button
                variant="secondary"
                onClick={() => setSt({ kind: "password", purpose: "codes", busy: false, error: null })}
              >
                New recovery codes
              </Button>
              {session.twoFactor.required ? (
                <p className={s.muted}>Your role requires it, so it stays on.</p>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => setSt({ kind: "password", purpose: "off", busy: false, error: null })}
                >
                  Turn off
                </Button>
              )}
            </>
          ) : (
            <Button variant="primary" onClick={() => void startEnrol()}>
              Turn on
            </Button>
          )}
        </div>
      )}

      {st.kind === "password" && (
        <form
          method="post"
          className={s.confirmBox}
          onSubmit={(e) => {
            e.preventDefault();
            void withPassword();
          }}
        >
          <p className={s.dialogText}>
            {st.purpose === "codes"
              ? "New codes replace the old ones, which stop working at once. Confirm it’s you."
              : "Signing in will only ask for your password. Confirm it’s you."}
          </p>
          <Field label="Your password" error={st.error}>
            {(control) => (
              <input
                {...control}
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          <div className={s.rowActions}>
            <Button variant="ghost" onClick={() => setSt({ kind: "idle" })}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={st.purpose === "off" ? "danger" : "primary"}
              loading={st.busy}
              disabled={!password}
            >
              {st.purpose === "codes" ? "Replace my codes" : "Turn off two-step sign-in"}
            </Button>
          </div>
        </form>
      )}

      {st.kind === "enrol" && (
        <div className={s.enrol}>
          <div className={s.qrSlot}>
            {st.enrolment && <QrCode text={st.enrolment.otpauthUri} size={150} />}
          </div>
          <div className={s.stack}>
            <ol className={s.howto}>
              <li>Open Google Authenticator, 1Password or any authenticator app.</li>
              <li>Scan this code.</li>
              <li>Type the 6-digit code it shows.</li>
            </ol>
            <OtpInput
              key={st.key}
              label="6-digit code"
              onComplete={(c) => void confirmCode(c)}
              disabled={!st.enrolment}
            />
            {st.enrolment && (
              <p className={s.muted}>
                Can’t scan? Enter this key: <code className={s.secret}>{st.enrolment.secret}</code>
              </p>
            )}
            {st.error && (
              <p role="alert" className={s.problem}>
                {st.error}
              </p>
            )}
            <Button variant="ghost" className={s.addPackage} onClick={() => setSt({ kind: "idle" })}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {st.kind === "codes" && (
        <div className={s.stack}>
          <p className={s.dialogText}>
            <b>{st.fresh === "replaced" ? "The old codes stop working now." : "Two-step sign-in is on."}</b>{" "}
            Each code signs you in once if you lose your phone. LUME can’t show them again.
          </p>
          <RecoveryCodeList
            codes={st.codes}
            saved={st.saved}
            onSavedChange={(saved) => setSt({ ...st, saved })}
          />
          <Button
            variant="primary"
            className={s.addPackage}
            disabled={!st.saved}
            onClick={() => setSt({ kind: "idle" })}
          >
            Done
          </Button>
        </div>
      )}
    </Block>
  );
}

function Sessions() {
  const [sessions, setSessions] = useState<MySession[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void accountClient.sessions().then((r) => {
      if (!live) return;
      if (r.ok) setSessions(r.data.sessions);
      else setProblem("Your sessions couldn’t load.");
    });
    return () => {
      live = false;
    };
  }, []);

  const end = async (ids: string[]) => {
    for (const id of ids) {
      const r = await accountClient.endSession(id);
      if (!r.ok) return setProblem(r.message || "That session couldn’t be ended.");
      setSessions((all) => all?.filter((x) => x.id !== id) ?? null);
    }
  };

  const others = sessions?.filter((x) => !x.current) ?? [];
  return (
    <Block
      title="Where you’re signed in"
      lede="Anything you don’t recognise, end it, then change your password."
    >
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      {sessions === null ? (
        !problem && <p className={s.muted}>Loading…</p>
      ) : (
        <ul className={s.sessionList}>
          {sessions.map((x) => {
            const device = deviceName(x.userAgent);
            return (
              <li key={x.id} className={s.sessionRow}>
                <div className={s.personText}>
                  <span className={s.personName}>{device}</span>
                  <span className={s.personMeta}>
                    {x.ip ?? "Unknown network"} · active {shortDateTime(x.lastSeenAt)}
                  </span>
                </div>
                {x.current ? (
                  <span className={s.chip} data-tone="ok">
                    This device
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`End session on ${device}`}
                    onClick={() => void end([x.id])}
                  >
                    End
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {others.length > 1 && (
        <Button
          variant="secondary"
          className={s.addPackage}
          onClick={() => void end(others.map((x) => x.id))}
        >
          Sign out everywhere else
        </Button>
      )}
    </Block>
  );
}
