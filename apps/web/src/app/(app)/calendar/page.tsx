import { EmptyState } from "@/components/ui/EmptyState";

export const metadata = { title: "Calendar · LUME" };

export default function Page() {
  return (
    <section data-stagger>
      <EmptyState
        title="Lead meetings only"
        body="Calls with leads (never your personal events) arrive in Phase 5."
      />
    </section>
  );
}
