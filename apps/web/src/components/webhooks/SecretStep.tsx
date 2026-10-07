"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import s from "@/components/imports/imports.module.css";
import type { WebhookMode, WebhookPreset } from "@/lib/webhooks/types";
import w from "./webhooks.module.css";

/** The address and the secret, with Copy; the secret is shown this once (spec §2 Security). */
export function SecretBox({ address, secret }: { address?: string; secret: string }) {
  return (
    <div className={w.secretBox}>
      {address && <CopyRow label="Address" value={address} />}
      <CopyRow label="Secret" value={secret} />
      <p className={w.once}>LUME won't show this again. Copy it now.</p>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  // "Copied" only when it was: a secret shown once must never be thought saved when it wasn't.
  const copy = async () => {
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // A refused clipboard: the value is on screen to copy by hand.
    }
  };
  return (
    <div className={w.secretRow}>
      <span className={w.secretLabel}>{label}</span>
      <code>{value}</code>
      <Button
        size="sm"
        aria-label={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
        onClick={() => void copy()}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

const signedSample = (address: string) => `// Node.js, on your server (or in a Code by Zapier step)
const { createHmac } = require("node:crypto");

const body = JSON.stringify({ name, phone, email });
const ts = Math.floor(Date.now() / 1000).toString();
const sig = "sha256=" + createHmac("sha256", process.env.LUME_WEBHOOK_SECRET)
  .update(ts + "." + body)
  .digest("hex");

await fetch("${address}", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-lume-timestamp": ts,
    "x-lume-signature": sig,
  },
  body,
});`;

const makeSample = (address: string) => `POST ${address}
Content-Type: application/json
X-Lume-Timestamp: <the time now, in Unix seconds>
X-Lume-Signature: sha256=<HMAC-SHA256, in hex, of "<timestamp>.<body>" with your secret>

{ "name": "…", "phone": "…", "email": "…" }`;

const tokenSample = (address: string) => `POST ${address}
Content-Type: application/json
X-Lume-Token: <your secret>

{ "first_name": "…", "last_name": "…", "phone": "…", "email": "…", "ig_username": "…" }`;

/** Step 2: where to post, the secret, and how to send one. */
export function SecretStep({
  preset,
  mode,
  address,
  secret,
  onContinue,
}: {
  preset: WebhookPreset;
  mode: WebhookMode;
  address: string;
  secret: string;
  onContinue(): void;
}) {
  const sample =
    mode === "token" ? tokenSample(address) : preset === "make" ? makeSample(address) : signedSample(address);
  return (
    <>
      <section className={s.body}>
        <h3 className={s.stepTitle}>Address and secret</h3>
        <p className={s.lede}>
          {mode === "token"
            ? "Post each new lead to this address, with the secret in an X-Lume-Token header."
            : "Post each new lead to this address, signed with the secret. LUME refuses anything unsigned."}
        </p>
        <SecretBox address={address} secret={secret} />
        <pre className={w.sample} aria-label="Code sample">
          {sample}
        </pre>
        {mode === "signed" && (
          <p className={w.sampleNote}>Sign on your server: a secret in a web page isn't secret.</p>
        )}
      </section>
      <footer className={s.foot}>
        <p className={s.footNote}>Next, send one test post.</p>
        <Button variant="primary" onClick={onContinue}>
          Continue
        </Button>
      </footer>
    </>
  );
}
