import { EmptyState } from "@/components/ui/EmptyState";

export const metadata = { title: "Pipeline · LUME" };

export default function Page() {
  return (
    <section data-stagger>
      <EmptyState
        title="Your pipeline"
        body="Drag leads between your own stages. Arrives with leads in Phase 1."
      />
    </section>
  );
}
