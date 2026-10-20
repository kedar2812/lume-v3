"use client";
import { useEffect, useState } from "react";
import { contentUrl, type LibraryFile } from "@/lib/files/client";
import v from "./viewer.module.css";

/** The most of a text file shown: a megabyte is a book; more is read in a text editor. */
const MOST = 1024 * 1024;

/** A text file on a sheet of paper, as it was written (Media). */
export function TextView({ file: f }: { file: LibraryFile }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    void fetch(contentUrl(f.id), {
      credentials: "same-origin",
      signal: ctl.signal,
      headers: f.size > MOST ? { range: `bytes=0-${MOST - 1}` } : {},
    })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(setText)
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setFailed(true);
      });
    return () => ctl.abort();
  }, [f.id, f.size]);
  if (failed)
    return <p className={v.say}>LUME couldn&apos;t open this file just now. Close it and try again.</p>;
  return (
    <article className={v.text} aria-busy={text === null || undefined} aria-label={f.name} tabIndex={0}>
      {text === null ? <span className={v.textLoading} aria-hidden /> : <pre>{text}</pre>}
      {text !== null && f.size > MOST && <p className={v.cut}>LUME shows the first megabyte of this file.</p>}
    </article>
  );
}
