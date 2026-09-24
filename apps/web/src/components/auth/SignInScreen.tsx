"use client";
import { useRouter } from "next/navigation";
import { SignInForm } from "@/components/auth/SignInForm";
import s from "@/components/auth/auth.module.css";
import { signIn, verifyOtp, verifyRecoveryCode } from "@/lib/auth-client";

export function SignInScreen({ businessName, next }: { businessName: string; next: string }) {
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
      />
    </div>
  );
}
