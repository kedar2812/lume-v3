import { CORE_FIELDS, PRESETS, newId, type PresetKey } from "@lume/core";
import { eq } from "drizzle-orm";
import { schema } from "@lume/db";
import type { Db } from "../../db/context";

/** First-run configuration from a code-defined preset (report §5.2 industry_presets). One transaction. */
export async function seedConfiguration(db: Db, presetKey: PresetKey): Promise<void> {
  const preset = PRESETS[presetKey];
  await db.insert(schema.fieldDefinitions).values([
    ...CORE_FIELDS.map((f, i) => ({
      id: newId(),
      key: f.key,
      label: f.label,
      type: f.type,
      isCore: true,
      isRequired: f.isRequired,
      position: i,
    })),
    ...preset.fields.map((f, i) => ({
      id: newId(),
      key: f.key,
      label: f.label,
      type: f.type,
      options: (f.options ?? []).map((o) => ({
        id: newId(),
        label: o.label,
        ...(o.color ? { color: o.color } : {}),
      })),
      position: CORE_FIELDS.length + i,
    })),
  ]);
  const pipelineId = newId();
  await db.insert(schema.pipelines).values({ id: pipelineId, name: preset.pipeline.name, isDefault: true });
  const stageIds = new Map(preset.pipeline.stages.map((s) => [s.name, newId()]));
  const moveTo = (pairs: [string, string][], from: string) => {
    const to = pairs.find(([f]) => f === from)?.[1];
    return to ? (stageIds.get(to) ?? null) : null;
  };
  await db.insert(schema.stages).values(
    preset.pipeline.stages.map((s, i) => ({
      id: stageIds.get(s.name)!,
      // Where a lead goes after a message or a reply (4A): the preset's moves, by stage name.
      afterSentStageId: moveTo(preset.moves.afterSent, s.name),
      afterReplyStageId: moveTo(preset.moves.afterReply, s.name),
      pipelineId,
      name: s.name,
      kind: s.kind,
      color: s.color,
      winProbability: s.winProbability,
      position: i,
      // A new install's Won and Lost stages clear open follow-ups (3C): a closed lead needs none.
      onEnter: s.kind === "open" ? {} : { rules: [{ id: newId(), type: "cancel_open_tasks" as const }] },
    })),
  );
  // Starter templates (4A), each with its first version.
  for (const [i, t] of preset.templates.entries()) {
    const id = newId();
    const versionId = newId();
    await db.insert(schema.messageTemplates).values({ id, name: t.name, category: t.category, position: i });
    await db.insert(schema.templateVersions).values({ id: versionId, templateId: id, body: t.body });
    await db
      .update(schema.messageTemplates)
      .set({ currentVersionId: versionId })
      .where(eq(schema.messageTemplates.id, id));
  }
  if (preset.lostReasons.length) {
    await db
      .insert(schema.lostReasons)
      .values(preset.lostReasons.map((label, i) => ({ id: newId(), label, position: i })));
  }
}
