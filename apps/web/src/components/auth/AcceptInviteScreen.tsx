"use client";
import { useRouter } from "next/navigation";
import s from "@/components/auth/auth.module.css";
import { acceptInvite } from "@/lib/auth-client";
import { AcceptInvite, type Invite } from "./AcceptInvite";

export function AcceptInviteScreen({ token, invite }: { token: string; invite: Invite }) {
  const router = useRouter();
  return (
    <div className={s.page}>
      <div className={s.aura} aria-hidden>
        <i />
        <i />
      </div>
      {/* The API signs them in, so onboarding is the next thing they see. */}
      <AcceptInvite
        invite={invite}
        onAccept={(password) => acceptInvite(token, password)}
        onDone={() => router.replace("/welcome")}
      />
    </div>
  );
}
