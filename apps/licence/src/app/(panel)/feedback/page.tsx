import { FeedbackScreen } from "@/components/FeedbackScreen";

export const metadata = { title: "Feedback · LUME Licences" };
export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; fixedIn?: string; tab?: string }>;
}) {
  return <FeedbackScreen initial={await searchParams} />;
}
