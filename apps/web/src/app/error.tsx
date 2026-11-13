"use client";
import { useRouter } from "next/navigation";
import { startTransition } from "react";
import { ErrorState } from "@/components/ui/ErrorState";
import s from "./error.module.css";

/**
 * A page that couldn't open (night QA 2026-11-13): most often LUME's server not answering for a moment (restarting
 * during an update). Said plainly, with Try again, which asks the server again rather than showing the same failure.
 */
export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  return (
    <main className={s.page}>
      <ErrorState
        title="LUME couldn’t open this page"
        message="Its server didn’t answer just now. Try again in a moment. If it keeps happening, let your admin know."
        action={{
          label: "Try again",
          onClick: () =>
            startTransition(() => {
              router.refresh();
              reset();
            }),
        }}
      />
    </main>
  );
}
