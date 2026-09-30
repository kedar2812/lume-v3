"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Bell } from "./Bell";
import { Toast, useToast } from "./bits";
import { Head } from "./Shell";

type Settings = {
  listPriceInr: number;
  latestVersion: string | null;
  billingContact: string | null;
  email: string;
};

/** Settings (spec §4.4): the list price, the latest version, the billing contact, and the admin's own sign-in. */
export function SettingsScreen() {
  const [s, setS] = useState<Settings | null>(null);
  const [list, setList] = useState("");
  const [latest, setLatest] = useState("");
  const [contact, setContact] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [enrol, setEnrol] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [current2, setCurrent2] = useState("");
  const [error, setError] = useState<{ where: string; text: string } | null>(null);
  const [toast, say] = useToast();

  useEffect(() => {
    void api.get<Settings>("/api/settings").then((x) => {
      if (!x.ok) return;
      setS(x.data);
      setList(String(x.data.listPriceInr || ""));
      setLatest(x.data.latestVersion ?? "");
      setContact(x.data.billingContact ?? "");
    });
  }, []);

  const saveBusiness = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await api.patch<Settings>("/api/settings", {
      listPriceInr: Number(list.replace(/,/g, "")) || 0,
      latestVersion: latest.trim() || null,
      billingContact: contact.trim() || null,
    });
    if (!r.ok)
      return setError({
        where: "business",
        text: "Check the version (like 1.4.2) and the contact (mailto:, tel: or https:).",
      });
    setS(r.data);
    say("Saved");
  };
  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await api.post("/api/settings/password", { current, next });
    if (!r.ok) return setError({ where: "password", text: r.message });
    setCurrent("");
    setNext("");
    say("Password changed · other sessions were signed out");
  };
  const startEnrol = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await api.post<{ secret: string; uri: string }>("/api/settings/two-step", { code: current2 });
    if (!r.ok) return setError({ where: "two-step", text: r.message });
    setCurrent2("");
    setEnrol(r.data);
  };
  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await api.post("/api/settings/two-step/confirm", { code });
    if (!r.ok) return setError({ where: "two-step", text: r.message });
    setEnrol(null);
    setCode("");
    say("Two-step switched to the new authenticator");
  };

  return (
    <>
      <Head title="Settings" sub={s ? `Signed in as ${s.email}.` : undefined}>
        <Bell />
      </Head>
      <div className="body" style={{ maxWidth: 760 }}>
        <form className="card" aria-label="Business" onSubmit={(e) => void saveBusiness(e)}>
          <h2 className="h">Business</h2>
          <label className="field">
            List price, a month
            <span className="money-in">
              <span aria-hidden>₹</span>
              <input
                className="input num"
                inputMode="decimal"
                value={list}
                onChange={(e) => setList(e.target.value.replace(/[^\d.,]/g, ""))}
                style={{ paddingLeft: 26 }}
              />
            </span>
          </label>
          <label className="field">
            Latest version
            <input
              className="input num"
              value={latest}
              onChange={(e) => setLatest(e.target.value)}
              placeholder="1.4.2"
            />
          </label>
          <label className="field">
            Where &ldquo;Contact about payment&rdquo; goes
            <input
              className="input"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="mailto:billing@example.com"
            />
          </label>
          {error?.where === "business" && (
            <p role="alert" style={{ margin: 0, color: "var(--redInk)", fontSize: 13 }}>
              {error.text}
            </p>
          )}
          <div>
            <button type="submit" className="btn primary">
              Save
            </button>
          </div>
        </form>

        <form className="card" aria-label="Password" onSubmit={(e) => void savePassword(e)}>
          <h2 className="h">Password</h2>
          <label className="field">
            Current password
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label className="field">
            New password
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
          <span className="note">At least 12 characters. A few words you&apos;ll remember is good.</span>
          {error?.where === "password" && (
            <p role="alert" style={{ margin: 0, color: "var(--redInk)", fontSize: 13 }}>
              {error.text}
            </p>
          )}
          <div>
            <button type="submit" className="btn primary" disabled={!current || !next}>
              Change password
            </button>
          </div>
        </form>

        <section className="card" aria-label="Two-step sign-in">
          <h2 className="h">Two-step sign-in</h2>
          {!enrol ? (
            <form
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
              onSubmit={(e) => void startEnrol(e)}
            >
              <span style={{ fontSize: 13.5, color: "var(--ink2)" }}>
                On. To move it to a new phone, make a new code for your authenticator; the old one works until
                you confirm.
              </span>
              <label className="field">
                The six digits your authenticator shows now
                <input
                  className="input num"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={current2}
                  onChange={(e) => setCurrent2(e.target.value.replace(/\D/g, ""))}
                />
              </label>
              {error?.where === "two-step" && (
                <p role="alert" style={{ margin: 0, color: "var(--redInk)", fontSize: 13 }}>
                  {error.text}
                </p>
              )}
              <div>
                <button type="submit" className="btn second" disabled={current2.length !== 6}>
                  Set up a new authenticator
                </button>
              </div>
            </form>
          ) : (
            <form
              className="reveal"
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
              onSubmit={(e) => void confirm(e)}
            >
              <span style={{ fontSize: 13.5, color: "var(--ink2)" }}>
                Add this to your authenticator app, then type the six digits it shows.
              </span>
              <div className="keybox">
                <span className="mono" style={{ overflowWrap: "anywhere" }}>
                  {enrol.secret}
                </span>
              </div>
              <a href={enrol.uri} style={{ fontSize: 12.5, fontWeight: 600 }}>
                Open in an authenticator on this device
              </a>
              <label className="field">
                Six digits
                <input
                  className="input num"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                />
              </label>
              {error?.where === "two-step" && (
                <p role="alert" style={{ margin: 0, color: "var(--redInk)", fontSize: 13 }}>
                  {error.text}
                </p>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn second" onClick={() => setEnrol(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={code.length !== 6}>
                  Confirm
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
      <Toast msg={toast} />
    </>
  );
}
