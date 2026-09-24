import { ForgotForm } from "@/components/auth/ForgotForm";
import s from "@/components/auth/auth.module.css";
import { publicBusinessName } from "@/server/public-settings";

export default async function ForgotPage() {
  return (
    <div className={s.page}>
      <div className={s.aura} aria-hidden>
        <i />
        <i />
      </div>
      <ForgotForm businessName={await publicBusinessName()} />
    </div>
  );
}
