import { EmptyState } from "@/components/ui/EmptyState";

export const metadata = { title: "Settings · LUME" };

export default function Page() {
  return (
    <section data-stagger>
      <EmptyState title="Make LUME yours" body="Pipelines, fields, roles and access arrive in Phase 1." />
    </section>
  );
}
