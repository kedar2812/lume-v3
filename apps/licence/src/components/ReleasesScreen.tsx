"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { compareVersions } from "@/lib/alerts";
import { api } from "@/lib/client";
import { ago } from "@/lib/format";
import { Bell } from "./Bell";
import { Head } from "./Shell";

type Releases = {
  latest: string | null;
  versions: { version: string; clients: { id: string; name: string; lastCheckInAt: string }[] }[];
  waiting: { id: string; name: string }[];
};

/** Releases (spec §4.4): the latest version, and which clients run which. */
export function ReleasesScreen() {
  const [r, setR] = useState<Releases | null>(null);
  useEffect(() => {
    void api.get<Releases>("/api/releases").then((x) => x.ok && setR(x.data));
  }, []);
  const behind = r
    ? r.versions
        .filter((v) => r.latest && compareVersions(v.version, r.latest) < 0)
        .reduce((t, v) => t + v.clients.length, 0)
    : 0;
  return (
    <>
      <Head title="Releases" sub="Which version each installation runs. The latest is set in Settings.">
        <Bell />
      </Head>
      <div className="body">
        {r && (
          <section className="card" aria-label="Latest">
            <h2 className="h">Latest</h2>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <span className="big">{r.latest ?? "—"}</span>
              <span className="note">
                {r.latest
                  ? behind
                    ? `${behind} ${behind === 1 ? "installation is" : "installations are"} behind. Update them with scripts/update.sh.`
                    : "Every installation is on it."
                  : "Set the latest version in Settings, or it's the newest any installation reports."}
              </span>
            </div>
          </section>
        )}
        {r?.versions.map((v, i) => {
          const old = !!r.latest && compareVersions(v.version, r.latest) < 0;
          return (
            <section
              key={v.version}
              className="card"
              aria-label={`Version ${v.version}`}
              style={{ animationDelay: `${0.05 + i * 0.05}s` }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <h2
                  className="h"
                  style={{ fontSize: 14, letterSpacing: 0, textTransform: "none", color: "var(--ink)" }}
                >
                  {v.version}
                </h2>
                {old ? (
                  <span className="badge-soft">update</span>
                ) : (
                  <span className="pill active">
                    <i />
                    Latest
                  </span>
                )}
                <span className="note" style={{ marginLeft: "auto" }}>
                  {v.clients.length} {v.clients.length === 1 ? "installation" : "installations"}
                </span>
              </div>
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {v.clients.map((c) => (
                  <li key={c.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
                    <Link href={`/clients/${c.id}`} style={{ fontWeight: 600, textDecoration: "none" }}>
                      {c.name}
                    </Link>
                    <span className="note">checked in {ago(c.lastCheckInAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {r && r.waiting.length > 0 && (
          <section className="card" aria-label="Not installed yet">
            <h2 className="h">Not installed yet</h2>
            <p className="note" style={{ margin: 0 }}>
              {r.waiting.map((c) => c.name).join(", ")}
            </p>
          </section>
        )}
        {r && r.versions.length === 0 && r.waiting.length === 0 && (
          <p className="empty">No installations yet.</p>
        )}
      </div>
    </>
  );
}
