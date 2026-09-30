"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import s from "@/components/imports/imports.module.css";
import { webhooksClient } from "@/lib/webhooks/client";
import type { TestPost } from "@/lib/webhooks/types";
import w from "./webhooks.module.css";

const POLL_MS = 2000;
/** Waiting stops after this long; "Look again" starts it over. */
const GIVE_UP_MS = 10 * 60_000;

/**
 * Step 3: LUME waits for one real post, looking every 2 seconds, then lists what it sent. Its paths
 * become the columns of the usual steps (spec §2 Mapping); a nested object can't be one value.
 */
export function TestStep({ id, busy, onUse }: { id: string; busy: boolean; onUse(): void }) {
  const [post, setPost] = useState<TestPost | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  /** Bumped by "Look again", which starts waiting over. */
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (post) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const until = Date.now() + GIVE_UP_MS;
    setGaveUp(false);
    const look = async () => {
      const r = await webhooksClient.test(id);
      if (!live) return;
      if (!r.ok) setError(r.message);
      else {
        setError(null);
        if (r.data) return setPost(r.data);
      }
      if (Date.now() >= until) return setGaveUp(true);
      timer = setTimeout(() => void look(), POLL_MS);
    };
    void look();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, post, round]);

  return (
    <>
      <section className={s.body} aria-live="polite">
        <h3 className={s.stepTitle}>Send a test</h3>
        {!post ? (
          <>
            <p className={s.lede}>
              Send one post the way your form or tool will: a real-looking lead is best. This page updates the
              moment it arrives.
            </p>
            {gaveUp ? (
              <p className={w.waiting}>
                No post has arrived in 10 minutes. Check the address and secret where it posts from, then{" "}
                <Button size="sm" variant="ghost" onClick={() => setRound((n) => n + 1)}>
                  Look again
                </Button>
              </p>
            ) : (
              <p className={w.waiting}>
                <span className={w.pulse} aria-hidden />
                Waiting for the first post…
              </p>
            )}
            {error && (
              <p role="alert" className={`${s.note} ${s.problem}`}>
                {error}
              </p>
            )}
          </>
        ) : (
          <>
            <p className={s.lede}>It arrived. These are the fields it sent; next, say where each one goes.</p>
            <ul className={w.paths} aria-label="What the post sent">
              {post.paths.map((p) => (
                <li key={p} className={w.path}>
                  {p}
                </li>
              ))}
              {post.unmappable.map((p) => (
                <li key={p} className={w.path} data-unmappable>
                  {p}
                </li>
              ))}
            </ul>
            {post.unmappable.length > 0 && (
              <p className={w.sampleNote}>
                {post.unmappable.join(", ")}: not a single value, so it can't go in a field.
              </p>
            )}
          </>
        )}
      </section>
      <footer className={s.foot}>
        <p className={s.footNote}>The test post doesn't become a lead unless you keep it.</p>
        <Button variant="primary" loading={busy} disabled={!post} onClick={onUse}>
          Use this post
        </Button>
      </footer>
    </>
  );
}
