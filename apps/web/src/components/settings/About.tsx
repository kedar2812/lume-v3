"use client";
import { useEffect, useState } from "react";
import { LUME_OWNER } from "@lume/core/shared";
import { aboutClient, type AboutInfo } from "@/lib/settings/about";
import { settingsDate } from "@/lib/settings/format";
import { useZone } from "@/components/ZoneProvider";
import s from "./settings.module.css";

/** Which LUME is running, and whether last week's backup could actually be restored (it's tested weekly). */
export function About() {
  const tz = useZone();
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void aboutClient.get().then((r) => {
      if (!live) return;
      if (r.ok) setInfo(r.data);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, []);

  if (failed)
    return <p className={s.problem}>LUME couldn’t read its own details just now. Reload to try again.</p>;
  if (!info) return <p className={s.muted}>Loading…</p>;
  const t = info.lastRestoreTest;

  return (
    <div className={s.stack}>
      <section className={s.panel} aria-label="About LUME">
        <dl className={s.facts}>
          <div>
            <dt>Running</dt>
            <dd>Version {info.version}</dd>
          </div>
          <div>
            <dt>Made by</dt>
            <dd>Created and owned by {LUME_OWNER}</dd>
            <dd className={s.muted}>
              © {new Date().getFullYear()} {LUME_OWNER}. All rights reserved.
            </dd>
          </div>
          <div>
            <dt>Backups</dt>
            <dd>
              {t ? (
                <>
                  <span className={s.restoreDot} data-ok={t.ok || undefined} aria-hidden />
                  <span>
                    Last restore test: {t.ok ? "passed" : "failed"}, {settingsDate(t.finishedAt, tz)}
                  </span>
                </>
              ) : (
                <span>No restore test has run yet</span>
              )}
            </dd>
            <dd className={s.muted}>
              {t && !t.ok
                ? "The latest backup couldn’t be restored in the weekly test. Whoever runs your server should look at it today."
                : "Every week the newest backup is restored into a scratch database and checked, so a backup is known to work before it’s needed."}
              {t?.backup && ` Tested: ${t.backup}.`}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
