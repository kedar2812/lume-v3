"use client";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { MoneyInput } from "@/components/ui/MoneyInput";
import type { ApiResult } from "@/lib/api";
import type { Catalog, LostReason, Product, Tag } from "@/lib/leads/types";
import { listsClient } from "@/lib/settings/lists";
import { accessGone } from "@/lib/settings/access";
import { AccessChanged } from "./AccessChanged";
import { COLOURS, ColourPicker } from "./ColourPicker";
import { ListEditor } from "./ListEditor";
import s from "./settings.module.css";

type Note = { text: string; problem?: boolean } | null;

/** An amount as typed ("1,500.50"): a number, null for empty, or undefined when it isn't an amount. */
export function parseAmount(raw: string): number | null | undefined {
  const t = raw.replace(/[\s,]/g, "");
  if (!t) return null;
  if (!/^\d*\.?\d{0,2}$/.test(t) || t === ".") return undefined;
  return Number(t);
}
const shown = (n: number | null) =>
  n === null ? "" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * The short lists people pick from while working leads: why a lead was lost, the tags they wear, and
 * the packages sold (each with a usual price in the business currency). Changes save as they're made.
 */
export function Lists({
  catalog,
  manage,
}: {
  catalog: Catalog;
  /** Which lists this person may change: reasons need pipelines.manage, tags and packages settings.manage. */
  manage: { reasons: boolean; tagsAndPackages: boolean };
}) {
  const [reasons, setReasons] = useState<LostReason[]>(
    [...catalog.lostReasons].sort((a, b) => a.position - b.position),
  );
  const [tags, setTags] = useState<Tag[]>(catalog.tags);
  const [products, setProducts] = useState<Product[]>(catalog.products);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [forbidden, setForbidden] = useState(false);

  if (forbidden) return <AccessChanged />;

  /** Whether a result landed; a refusal is said in its own section, and a 403 means access changed. */
  const landed =
    (section: string) =>
    <T,>(r: ApiResult<T>): r is Extract<ApiResult<T>, { ok: true }> => {
      if (r.ok) {
        setNotes((n) => ({ ...n, [section]: { text: "Saved" } }));
        return true;
      }
      if (accessGone(r)) setForbidden(true);
      else
        setNotes((n) => ({
          ...n,
          [section]: { text: r.message || "That couldn’t be saved.", problem: true },
        }));
      return false;
    };

  // ── lost reasons ──
  const reasonsOk = landed("reasons");
  const reorderReasons = async (ids: string[]) => {
    const before = reasons;
    const next = ids.map((id, position) => ({ ...reasons.find((r) => r.id === id)!, position }));
    setReasons(next);
    for (const r of next) {
      if (before.find((b) => b.id === r.id)!.position === r.position) continue;
      if (!reasonsOk(await listsClient.patchReason(r.id, { position: r.position })))
        return setReasons(before);
    }
  };

  // ── tags ──
  const tagsOk = landed("tags");
  const nextColour = () => {
    const used = new Map<string, number>(COLOURS.map(([t]) => [t, 0]));
    for (const t of tags) used.set(t.color, (used.get(t.color) ?? 0) + 1);
    return [...used].sort((a, b) => a[1] - b[1])[0]![0]; // the least-used colour, so tags stay apart
  };

  // ── packages ──
  const productsOk = landed("products");

  return (
    <div className={s.stack}>
      {manage.reasons && (
        <ListSection
          id="reasons"
          title="Lost reasons"
          blurb="Asked for whenever a lead is marked Lost."
          note={notes.reasons}
        >
          <ListEditor
            items={reasons.map((r) => ({ ...r }))}
            itemLabel="Reason"
            addLabel="Add a reason"
            onAdd={async (label) => {
              const r = await listsClient.createReason(label);
              if (reasonsOk(r)) setReasons((all) => [...all, r.data.lostReason]);
            }}
            onRename={async (id, label) => {
              const r = await listsClient.patchReason(id, { label });
              if (reasonsOk(r)) setReasons((all) => all.map((x) => (x.id === id ? { ...x, label } : x)));
            }}
            onReorder={(ids) => void reorderReasons(ids)}
            onArchive={async (id) => {
              if (reasonsOk(await listsClient.archiveReason(id)))
                setReasons((all) => all.filter((x) => x.id !== id));
            }}
            archiveNote="Leads lost for this reason keep it; it just can’t be picked any more."
          />
        </ListSection>
      )}

      {manage.tagsAndPackages && (
        <ListSection
          id="tags"
          title="Tags"
          blurb="Labels for leads, to sort and filter by."
          note={notes.tags}
        >
          <ListEditor
            items={tags}
            itemLabel="Tag"
            addLabel="Add a tag"
            onAdd={async (label) => {
              const r = await listsClient.createTag({ label, color: nextColour() });
              if (tagsOk(r))
                setTags((all) => [...all, r.data.tag].sort((a, b) => a.label.localeCompare(b.label)));
            }}
            onRename={async (id, label) => {
              const r = await listsClient.patchTag(id, { label });
              if (tagsOk(r)) setTags((all) => all.map((x) => (x.id === id ? r.data.tag : x)));
            }}
            onArchive={async (id) => {
              if (tagsOk(await listsClient.deleteTag(id))) setTags((all) => all.filter((x) => x.id !== id));
            }}
            archiveVerb="Remove"
            archiveNote="It comes off every lead that has it."
            renderExtra={(tag) => (
              <ColourPicker
                label={`Colour for ${tag.label}`}
                value={tag.color}
                onChange={async (color) => {
                  const before = tags;
                  setTags((all) => all.map((x) => (x.id === tag.id ? { ...x, color } : x)));
                  if (!tagsOk(await listsClient.patchTag(tag.id, { color }))) setTags(before);
                }}
              />
            )}
          />
        </ListSection>
      )}

      {manage.tagsAndPackages && (
        <ListSection
          id="products"
          title="Packages"
          blurb={`What you sell. A package’s price fills in a lead’s value; amounts are in ${catalog.currency}.`}
          note={notes.products}
        >
          <ListEditor
            items={products.map((p) => ({ ...p, label: p.name }))}
            itemLabel="Package"
            addLabel="Add a package"
            onRename={async (id, name) => {
              const r = await listsClient.patchProduct(id, { name });
              if (productsOk(r)) setProducts((all) => all.map((x) => (x.id === id ? r.data.product : x)));
            }}
            onArchive={async (id) => {
              if (productsOk(await listsClient.archiveProduct(id)))
                setProducts((all) => all.filter((x) => x.id !== id));
            }}
            archiveNote="Leads keep their values; it just can’t be picked any more."
            renderExtra={(p) => (
              <PriceCell
                product={p}
                currency={catalog.currency}
                onSave={async (defaultValue) => {
                  const r = await listsClient.patchProduct(p.id, { defaultValue });
                  if (productsOk(r))
                    setProducts((all) => all.map((x) => (x.id === p.id ? r.data.product : x)));
                }}
              />
            )}
          />
          <AddPackage
            currency={catalog.currency}
            onAdd={async (input) => {
              const r = await listsClient.createProduct(input);
              if (!productsOk(r)) return false;
              setProducts((all) => [...all, r.data.product]);
              return true;
            }}
          />
        </ListSection>
      )}
    </div>
  );
}

function ListSection({
  id,
  title,
  blurb,
  note,
  children,
}: {
  id: string;
  title: string;
  blurb: string;
  note: Note | undefined;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`list-${id}`} className={s.listSection}>
      <div className={s.listHead}>
        <h2 id={`list-${id}`} className={s.panelTitle}>
          {title}
        </h2>
        <p className={s.muted}>{blurb}</p>
      </div>
      {children}
      {note &&
        (note.problem ? (
          <p role="alert" className={s.problem}>
            {note.text}
          </p>
        ) : (
          <p role="status" className={s.saved}>
            {note.text}
          </p>
        ))}
    </section>
  );
}

/** A package's usual price, edited where it's shown; saved when the field is left. */
function PriceCell({
  product,
  currency,
  onSave,
}: {
  product: Product;
  currency: string;
  onSave: (value: number | null) => void;
}) {
  const [text, setText] = useState(shown(product.defaultValue));
  const commit = () => {
    const value = parseAmount(text);
    if (value === undefined) return setText(shown(product.defaultValue));
    if (value !== product.defaultValue) onSave(value);
  };
  return (
    <div className={s.priceCell}>
      <MoneyInput
        size="sm"
        amount={text}
        currency={currency}
        aria-label={`Price of ${product.name}`}
        onChange={setText}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </div>
  );
}

/** A new package: its name and usual price, together. */
function AddPackage({
  currency,
  onAdd,
}: {
  currency: string;
  onAdd: (input: { name: string; defaultValue: number | null }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!open)
    return (
      <Button size="sm" variant="secondary" className={s.addPackage} onClick={() => setOpen(true)}>
        Add a package
      </Button>
    );

  return (
    <form
      method="post"
      className={s.packageForm}
      onSubmit={async (e) => {
        e.preventDefault();
        const n = name.trim();
        if (!n) return setError("Give the package a name");
        const value = parseAmount(price);
        if (value === undefined) return setError("Enter an amount, like 1,500");
        if (await onAdd({ name: n, defaultValue: value })) {
          setName("");
          setPrice("");
          setError(null);
          setOpen(false);
        }
      }}
    >
      <label className={s.packageField}>
        <span>Package name</span>
        <input autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className={s.packageField}>
        <label htmlFor="new-package-price">Price</label>
        <MoneyInput
          id="new-package-price"
          size="sm"
          amount={price}
          currency={currency}
          onChange={setPrice}
          aria-invalid={error?.startsWith("Enter") || undefined}
        />
      </div>
      <div className={s.packageActions}>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" type="submit" variant="primary">
          Add
        </Button>
      </div>
      {error && (
        <p role="alert" className={s.problem}>
          {error}
        </p>
      )}
    </form>
  );
}
