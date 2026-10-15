"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import s from "@/components/auth/auth.module.css";
import { activateKey, completeSetup, startTotp } from "@/lib/setup-client";
import { SetupWizard } from "./SetupWizard";
import w from "./setup.module.css";

/** The signed-out canvas (same aura as sign-in), with the wizard in place of the sign-in card. */
export function SetupScreen({ needsKey = false }: { needsKey?: boolean }) {
  const router = useRouter();
  // While "your LUME is online" plays, the mark above the card steps aside: the moment has its own.
  const [celebrating, setCelebrating] = useState(false);
  return (
    <div className={`${s.page} ${w.page}`}>
      <div className={s.aura} aria-hidden>
        <i />
        <i />
      </div>
      <div className={w.wrap}>
        <div className={w.head} data-away={celebrating || undefined}>
          <img src="/lume-mark.png" alt="" className={w.mark} />
          <h1 className={w.brand}>LUME</h1>
        </div>
        <SetupWizard
          needsKey={needsKey}
          onActivateKey={activateKey}
          onCelebrate={setCelebrating}
          onStartTotp={startTotp}
          onComplete={completeSetup}
          onDone={() => router.replace("/welcome")}
        />
      </div>
    </div>
  );
}
