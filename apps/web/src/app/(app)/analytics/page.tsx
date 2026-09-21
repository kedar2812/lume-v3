import { EmptyState } from "@/components/ui/EmptyState";

export const metadata = { title: "Analytics · LUME" };

export default function Page() {
  return (
    <section data-stagger>
      <EmptyState
        title="Numbers that answer questions"
        body="Funnel, team and revenue analytics arrive in Phase 7."
      />
    </section>
  );
}
