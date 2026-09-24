import type { OnboardingStep, OnboardingStepId } from "@lume/core/shared";
import s from "../onboarding.module.css";
import { PanelHead } from "./Head";

/** What each step is for, in a few words, for the "here's what's coming" list. */
const WHAT: Partial<Record<OnboardingStepId, string>> = {
  you: "your name and timezone",
  secure: "two-step sign-in, required for your role",
  look: "light or dark",
  day: "your hours and morning digest",
  alerts: "notifications and sounds",
  team: "invite the people who’ll use LUME",
  pipeline: "check the stages leads move through",
  connect: "your Google tools",
};

export function WelcomePanel({
  firstName,
  businessName,
  steps,
  isOwner,
}: {
  firstName: string;
  businessName: string;
  steps: OnboardingStep[];
  isOwner: boolean;
}) {
  const workspace = steps.some((x) => x.group === "workspace");
  const lead = isOwner
    ? `${businessName || "Your workspace"} is ready. Your business details and pipeline came from the setup you just finished. Now let’s shape LUME around you and bring your team in.`
    : workspace
      ? `You’ll help run LUME for ${businessName || "the team"}, so a few things come first.`
      : `${businessName || "Your team"} uses LUME to keep every lead, follow-up and call in one calm place. Let’s set it up the way you work.`;
  return (
    <>
      <PanelHead
        kicker={isOwner ? "Welcome · Owner" : "Welcome"}
        title={`Welcome to LUME, ${firstName}`}
        lead={lead}
      />
      <ul className={s.summary}>
        {steps
          .filter((x) => WHAT[x.id])
          .map((x) => (
            <li key={x.id}>
              <b>{x.title}</b>
              {WHAT[x.id]}
            </li>
          ))}
      </ul>
    </>
  );
}
