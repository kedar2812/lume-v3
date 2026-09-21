import { EmptyState } from "@/components/ui/EmptyState";

export const metadata = { title: "Templates · LUME" };

export default function Page() {
  return (
    <section data-stagger>
      <EmptyState title="WhatsApp templates" body="Write once, send in one click. Arrives in Phase 4." />
    </section>
  );
}
