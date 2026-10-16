import { FleetScreen } from "@/components/FleetScreen";

export const metadata = { title: "Fleet · LUME Licences" };
export default async function FleetPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  return <FleetScreen initialTab={(await searchParams).tab} />;
}
