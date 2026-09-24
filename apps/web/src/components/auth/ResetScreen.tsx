"use client";
import { useRouter } from "next/navigation";
import s from "@/components/auth/auth.module.css";
import { resetPassword } from "@/lib/auth-client";
import { ResetForm } from "./ResetForm";

export function ResetScreen({ token, businessName }: { token: string; businessName: string }) {
  const router = useRouter();
  return (
    <div className={s.page}>
      <div className={s.aura} aria-hidden>
        <i />
        <i />
      </div>
      <ResetForm
        businessName={businessName}
        onReset={(password) => resetPassword(token, password)}
        onDone={() => setTimeout(() => router.replace("/sign-in"), 1200)}
      />
    </div>
  );
}
