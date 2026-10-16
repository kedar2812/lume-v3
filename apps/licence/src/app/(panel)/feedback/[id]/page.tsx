import { FeedbackReport } from "@/components/FeedbackReport";

export const metadata = { title: "Feedback · LUME Licences" };
export default async function FeedbackReportPage({ params }: { params: Promise<{ id: string }> }) {
  return <FeedbackReport id={(await params).id} />;
}
