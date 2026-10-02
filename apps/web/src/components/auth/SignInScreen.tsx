"use client";
import { useRouter } from "next/navigation";
import { SignInForm } from "@/components/auth/SignInForm";
import s from "@/components/auth/auth.module.css";
import { signIn, verifyOtp, verifyRecoveryCode } from "@/lib/auth-client";

export function SignInScreen({
  businessName,
  next,
  paused = false,
}: {
  businessName: string;
  next: string;
  /** A request was refused as paused (6A): open on the paused card. */
  paused?: boolean;
}) {
  const router = useRouter();
  return (
    <div className={s.page}>
      <div className={s.aura} aria-hidden>
        <i />
        <i />
      </div>
      <SignInForm
        businessName={businessName}
        onSignIn={signIn}
        onVerify={verifyOtp}
        onVerifyRecovery={verifyRecoveryCode}
        onSuccess={() => router.replace(next)}
        paused={paused}
      />
    </div>
  );
}
