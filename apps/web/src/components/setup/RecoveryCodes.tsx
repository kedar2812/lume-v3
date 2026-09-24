"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import s from "./setup.module.css";

/**
 * The ten recovery codes, shown once and never again, with Copy and Download (because "write these
 * down" is where most people quietly skip a step) and the "I've saved these" confirmation. The caller
 * decides what the confirmation unlocks: setup's Open LUME, or onboarding's Continue.
 */
export function RecoveryCodeList({
  codes,
  saved,
  onSavedChange,
}: {
  codes: string[];
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
}) {
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
        <input type="checkbox" checked={saved} onChange={(e) => onSavedChange(e.target.checked)} />
        <span>I’ve saved these somewhere safe</span>
      </label>
    </div>
  );
}

/** Setup's last screen: the codes, then Open LUME once they are saved. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <div>
      <p className={s.title}>Your recovery codes</p>
      <p className={s.sub}>
        Each one signs you in once if you ever lose your phone. Save these somewhere safe — LUME can’t show
        them again.
      </p>
      <RecoveryCodeList codes={codes} saved={saved} onSavedChange={setSaved} />
      <Button variant="primary" className={s.submit} disabled={!saved} onClick={onDone}>
        Open LUME
      </Button>
    </div>
  );
}
