"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LEGAL_DOCUMENTS, LEGAL_DRAFT, LEGAL_VERSION } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import s from "./agreement.module.css";

/**
 * The first thing anyone sees in LUME, before onboarding: the licence agreement, the terms of service
 * and the privacy policy, in one scrolling reader. "I agree" only unlocks once the reader has reached
 * the end; declining signs out. A new version brings everyone back here.
 */
export function AgreementScreen({ agreedVersion, next }: { agreedVersion: string | null; next: string }) {
  const router = useRouter();
  const reader = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [reached, setReached] = useState(false);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState<"agree" | "decline" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const updated = agreedVersion !== null;

  // The end of the text, seen inside the reader, unlocks agreement (and stays unlocked).
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setReached(true);
      },
      { root: reader.current, threshold: 1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const onScroll = () => {
    const r = reader.current;
    if (!r) return;
    const room = r.scrollHeight - r.clientHeight;
    setProgress(room > 0 ? Math.min(1, r.scrollTop / room) : 1);
  };

  const agree = async () => {
    setBusy("agree");
    setProblem(null);
    const r = await api.post("/api/v1/me/agreement", { version: LEGAL_VERSION });
    if (r.ok) return router.replace(next);
    setBusy(null);
    setProblem(
      r.status === 409
        ? "These documents changed while you were reading. Reload the page to read the current version."
        : r.message,
    );
  };

  const decline = async () => {
    setBusy("decline");
    await api.post("/api/v1/auth/logout");
    window.location.assign("/sign-in");
  };

  return (
    <main className={s.page}>
      <div className={s.aura} aria-hidden>
        <i />
        <i />
      </div>
      <div className={s.sheet}>
        <header className={s.head}>
          <img src="/lume-mark.png" alt="" className={s.mark} />
          <div>
            <h1 className={s.title}>{updated ? "We’ve updated our terms" : "Before you start"}</h1>
            <p className={s.lede}>
              {updated
                ? "Please read the new version of LUME’s licence agreement, terms of service and privacy policy."
                : "Please read LUME’s licence agreement, terms of service and privacy policy. They explain what you can do with LUME and how your data is looked after."}
            </p>
          </div>
        </header>

        {LEGAL_DRAFT && (
          <p className={s.draft}>
            Draft for legal review — the final wording may change before LUME goes live.
          </p>
        )}

        <nav className={s.tabs} aria-label="Documents">
          {LEGAL_DOCUMENTS.map((doc) => (
            <button
              key={doc.id}
              type="button"
              className={s.tab}
              onClick={() =>
                document
                  .getElementById(`legal-${doc.id}`)
                  ?.scrollIntoView({ block: "start", behavior: "smooth" })
              }
            >
              {doc.title}
            </button>
          ))}
        </nav>

        <div className={s.progress} aria-hidden>
          <i style={{ transform: `scaleX(${reached ? 1 : progress})` }} />
        </div>

        <div
          ref={reader}
          className={s.reader}
          role="region"
          aria-label="Licence agreement, terms of service and privacy policy"
          tabIndex={0}
          data-reached={reached || undefined}
          onScroll={onScroll}
        >
          {LEGAL_DOCUMENTS.map((doc) => (
            <section key={doc.id} className={s.doc} aria-labelledby={`legal-${doc.id}`}>
              <h2 id={`legal-${doc.id}`} className={s.docTitle}>
                {doc.title}
              </h2>
              {doc.sections.map((sec) => (
                <div key={sec.heading} className={s.section}>
                  <h3>{sec.heading}</h3>
                  {sec.paragraphs.map((p) => (
                    <p key={p}>{p}</p>
                  ))}
                </div>
              ))}
            </section>
          ))}
          <p className={s.version}>Version {LEGAL_VERSION}</p>
          <div ref={end} className={s.end} aria-hidden />
        </div>

        {problem && (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        )}

        <footer className={s.foot}>
          <p className={s.status} aria-live="polite" data-done={reached || undefined}>
            {reached ? "You’ve read to the end" : "Scroll to the end to agree"}
          </p>
          <Button
            variant="ghost"
            loading={busy === "decline"}
            disabled={busy !== null}
            onClick={() => void decline()}
          >
            Decline and sign out
          </Button>
          <Button
            variant="primary"
            loading={busy === "agree"}
            disabled={!reached || busy !== null}
            onClick={() => void agree()}
          >
            I agree
          </Button>
        </footer>
      </div>
    </main>
  );
}
