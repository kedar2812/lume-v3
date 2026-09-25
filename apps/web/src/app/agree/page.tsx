import { redirect } from "next/navigation";
import { AgreementScreen } from "@/components/legal/AgreementScreen";
import { firstRunStop } from "@/lib/first-run";
import { requireSession } from "@/server/session";

export const metadata = { title: "Before you start · LUME" };

export default async function AgreePage() {
  const session = await requireSession();
  const stop = firstRunStop(session.flags);
  if (stop !== "/agree") redirect(stop ?? "/today");
  const next = firstRunStop({ ...session.flags, needsAgreement: false }) ?? "/today";
  return <AgreementScreen agreedVersion={session.agreement.version} next={next} />;
}
