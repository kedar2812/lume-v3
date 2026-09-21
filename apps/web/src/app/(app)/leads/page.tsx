import { EmptyState } from "@/components/ui/EmptyState";

export const metadata = { title: "Leads · LUME" };

export default function Page() {
  return (
    <section data-stagger>
      <EmptyState
        title="Leads arrive in Phase 1"
        body="This is where every lead you can see will live: table and board, filters, saved views and bulk actions."
      />
    </section>
  );
}
