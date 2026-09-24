"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import s from "./setup.module.css";

/**
 * The ten recovery codes, shown once and never again — so this screen refuses to move on until the
 * person says they have saved them. Copy and download are offered because "write these down" is
 * where most people quietly skip a step.
 */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false); // a browser that refuses the clipboard still has the download
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "lume-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <p className={s.title}>Your recovery codes</p>
      <p className={s.sub}>
        Each one signs you in once if you ever lose your phone. Save these somewhere safe — LUME can’t show
        them again.
      </p>
      <ul className={s.codes}>
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className={s.codeActions}>
        <Button onClick={copy}>{copied ? "Copied" : "Copy all"}</Button>
        <Button onClick={download}>Download .txt</Button>
      </div>
      <label className={s.check}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I’ve saved these somewhere safe</span>
      </label>
      <Button variant="primary" className={s.submit} disabled={!saved} onClick={onDone}>
        Open LUME
      </Button>
    </div>
  );
}
