import { EnquiryScreen } from "@/components/EnquiryScreen";

export const metadata = { title: "Enquiry · LUME Licences" };
export default async function EnquiryPage({ params }: { params: Promise<{ id: string }> }) {
  return <EnquiryScreen id={(await params).id} />;
}
