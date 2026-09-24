import { redirect } from "next/navigation";
import { WelcomeScreen } from "@/components/onboarding/WelcomeScreen";
import { businessName, requireSession } from "@/server/session";

export default async function WelcomePage() {
  const session = await requireSession();
  // Nothing to do here once onboarding is done and any required enrolment is finished.
  if (!session.flags.needsOnboarding && !session.flags.needsTwoFactorEnrolment) redirect("/today");
  return <WelcomeScreen session={session} businessName={await businessName()} />;
}
