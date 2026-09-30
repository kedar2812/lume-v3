import { ClientScreen } from "@/components/ClientScreen";

export const metadata = { title: "Client · LUME Licences" };
export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  return <ClientScreen id={(await params).id} />;
}
