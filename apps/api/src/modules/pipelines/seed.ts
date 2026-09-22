import { CORE_FIELDS, PRESETS, newId, type PresetKey } from "@lume/core";
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
  await db.insert(schema.stages).values(
    preset.pipeline.stages.map((s, i) => ({
      id: newId(),
      pipelineId,
      name: s.name,
      kind: s.kind,
      color: s.color,
      winProbability: s.winProbability,
      position: i,
    })),
  );
  if (preset.lostReasons.length) {
    await db
      .insert(schema.lostReasons)
      .values(preset.lostReasons.map((label, i) => ({ id: newId(), label, position: i })));
  }
}
