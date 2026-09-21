"use client";
import { useRouter } from "next/navigation";
import { SignInForm } from "@/components/auth/SignInForm";
import s from "@/components/auth/auth.module.css";
import { signIn, verifyOtp } from "@/lib/auth-client";

export default function SignInPage() {
  const router = useRouter();
  return (
    <div className={s.page}>
      <div className={s.aura} aria-hidden>
        <i />
        <i />
      </div>
      {/* Phase 1: the business name comes from public settings. */}
      <SignInForm
        businessName="Nupuur Coaching"
        onSignIn={signIn}
        onVerify={verifyOtp}
        onSuccess={() => router.replace("/today")}
      />
    </div>
  );
}
