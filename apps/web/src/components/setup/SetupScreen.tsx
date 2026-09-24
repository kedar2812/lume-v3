"use client";
import { useRouter } from "next/navigation";
import s from "@/components/auth/auth.module.css";
import { completeSetup, startTotp } from "@/lib/setup-client";
import { SetupWizard } from "./SetupWizard";
import w from "./setup.module.css";

/** The signed-out canvas (same aura as sign-in), with the wizard in place of the sign-in card. */
export function SetupScreen() {
  const router = useRouter();
  return (
    <div className={s.page}>
      <div className={s.aura} aria-hidden>
        <i />
        <i />
      </div>
      <div className={w.wrap}>
        <img src="/lume-mark.png" alt="" className={w.mark} />
        <h1 className={w.brand}>LUME</h1>
        <SetupWizard
          onStartTotp={startTotp}
          onComplete={completeSetup}
          onDone={() => router.replace("/welcome")}
        />
      </div>
    </div>
  );
}
