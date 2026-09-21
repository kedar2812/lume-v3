import { EmptyState } from "@/components/ui/EmptyState";

export const metadata = { title: "Today · LUME" };

export default function Page() {
  return (
    <section data-stagger>
      <EmptyState
        title="Your day starts here"
        body="Follow-ups, calls and new leads that need you will appear here in Phase 3."
      />
    </section>
  );
}
