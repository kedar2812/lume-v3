"use client";
import { useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { CheckCircle } from "@/components/ui/CheckCircle";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Kbd } from "@/components/ui/Kbd";
import { Odometer } from "@/components/ui/Odometer";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import type { ThemePref } from "@/lib/theme";

const SWATCHES = [
  "canvas",
  "sheet",
  "sunk",
  "text",
  "text-2",
  "text-3",
  "accent",
  "danger",
  "warn",
  "meet",
  "ok",
  "cyan",
  "wa",
];
const section = { padding: "24px 0", borderTop: "0.5px solid var(--line)" } as const;
const row = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } as const;

export function Showcase({ theme }: { theme: ThemePref }) {
  const [range, setRange] = useState<"7" | "30" | "90">("30");
  const [cmp, setCmp] = useState(false);
  const [done, setDone] = useState(false);
  const [n, setN] = useState(42500);
  const { toast } = useToast();
  return (
    <main
      style={{
        maxWidth: 980,
        margin: "0 auto",
        padding: "36px 24px 120px",
        background: "var(--sheet)",
        minHeight: "100vh",
      }}
    >
      <div style={{ ...row, justifyContent: "space-between" }}>
        <h1 className="t-page">LUME design system</h1>
        <ThemeToggle initial={theme} />
      </div>
      <p className="t-meta" style={{ marginTop: 6 }}>
        Every primitive, in both themes. Visual snapshots and accessibility checks run against this page.
      </p>

      <section style={section}>
        <h2 className="t-section">Colour tokens</h2>
        <div style={{ ...row, marginTop: 12 }}>
          {SWATCHES.map((t) => (
            <div key={t} style={{ textAlign: "center", fontSize: 11, color: "var(--text-2)" }}>
              <div
                style={{
                  width: 56,
                  height: 40,
                  borderRadius: 10,
                  background: `var(--${t})`,
                  boxShadow: "inset 0 0 0 0.5px var(--line-2)",
                }}
              />
              {t}
            </div>
          ))}
        </div>
      </section>

      <section style={section}>
        <h2 className="t-section">Buttons</h2>
        <div style={{ ...row, marginTop: 12 }}>
          <Button variant="primary">Save changes</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="whatsapp">Send on WhatsApp</Button>
          <Button variant="danger">End sessions</Button>
          <Button variant="primary" loading>
            Saving
          </Button>
          <Button size="sm">Small</Button>
          <Kbd>Ctrl K</Kbd>
        </div>
      </section>

      <section style={section}>
        <h2 className="t-section">Chips and avatars</h2>
        <div style={{ ...row, marginTop: 12 }}>
          <Chip tone="danger" dot>
            Overdue
          </Chip>
          <Chip tone="warn" dot>
            Due soon
          </Chip>
          <Chip tone="meet" dot>
            Meeting
          </Chip>
          <Chip tone="ok" dot>
            Won
          </Chip>
          <Chip tone="accent" selected>
            Selected
          </Chip>
          <Avatar name="Aisha Khan" />
          <Avatar name="Rohan Malik" />
          <Avatar name="Tasneem" size={40} />
        </div>
      </section>

      <section style={section}>
        <h2 className="t-section">Controls</h2>
        <div style={{ ...row, marginTop: 12 }}>
          <SegmentedControl
            label="Range"
            value={range}
            options={[
              { value: "7", label: "7D" },
              { value: "30", label: "30D" },
              { value: "90", label: "90D" },
            ]}
            onChange={setRange}
          />
          <Switch checked={cmp} onChange={setCmp} label="Compare to previous" />
          <CheckCircle checked={done} onChange={setDone} label="Mark follow-up done" />
        </div>
      </section>

      <section style={section}>
        <h2 className="t-section">Numbers and progress</h2>
        <div style={{ ...row, marginTop: 12, fontSize: 26, fontWeight: 660, letterSpacing: "-0.03em" }}>
          <span>AED&nbsp;</span>
          <Odometer value={n} format={(v) => v.toLocaleString("en-US")} label="Revenue" />
          <Button size="sm" onClick={() => setN((v) => v + 1375)}>
            +1,375
          </Button>
          <ProgressRing value={0.66} label="Cleared today" />
        </div>
      </section>

      <section style={section}>
        <h2 className="t-section">Feedback</h2>
        <div style={{ ...row, marginTop: 12 }}>
          <Button
            onClick={() =>
              toast({
                tone: "ok",
                title: "Follow-up done",
                detail: "Aisha Khan · 3 of 6 cleared",
                sound: "done",
                action: { label: "Undo", onClick: () => undefined },
              })
            }
          >
            Success toast
          </Button>
          <Button onClick={() => toast({ tone: "warn", title: "Snoozed until tomorrow 10:00" })}>
            Silent toast
          </Button>
        </div>
        <div style={{ display: "grid", gap: 8, marginTop: 16, maxWidth: 420 }}>
          <Skeleton width={140} height={12} />
          <Skeleton height={34} />
          <Skeleton height={60} radius={12} />
        </div>
      </section>

      <section style={section}>
        <EmptyState
          title="You’re all caught up"
          body="Nothing needs you right now. New follow-ups and bookings will land here."
        />
      </section>
    </main>
  );
}
