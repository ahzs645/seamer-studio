// SeamlyMe (.smis — SeamlyMe individual measurements XML, the .vit successor) exporter, the
// reciprocal of seamlyImport's measurement reading. Exports the body's completed measurement set
// (user-entered values + statistically regressed estimates) under the Seamly2D/SeamlyMe "known
// measurement" codes (the `externalName` of each def in base_model.json), plus the derived
// half-arc measurements and the `size` alias SeamlyMe defines, matching the original studio's
// SeamlyExporter output byte-for-byte in structure.

import type { Body } from '@seamer/pattern-model';
import { loadAvatarAssets, loadGenderModel } from '@seamer/avatar';
import { completeMeasurements, toMetricKnown } from '@seamer/avatar';

const SEAMLYME_VERSION = '0.3.3';
const CM_PER_IN = 2.54;

// SeamlyMe knows these half measurements; we model the full arcs, so derive target = source / 2.
const DERIVED_HALF: Record<string, string> = {
  bust_arc_half_f: 'bust_arc_f',
  waist_arc_half_f: 'waist_arc_f',
  hip_arc_half_f: 'hip_arc_f',
  highhip_arc_half_f: 'highhip_arc_f',
  neck_arc_half_f: 'neck_arc_f',
  bust_arc_half_b: 'bust_arc_b',
  waist_arc_half_b: 'waist_arc_b',
  hip_arc_half_b: 'hip_arc_b',
  highhip_arc_half_b: 'highhip_arc_b',
  neck_arc_half_b: 'neck_arc_b',
  across_chest_half_f: 'across_chest_f',
  across_back_half_b: 'across_back_b',
  bustpoint_to_bustpoint_half: 'bustpoint_to_bustpoint'
};
// SeamlyMe codes that alias another exported measurement verbatim.
const COPIED: Record<string, string> = { size: 'bust_arc_f' };

interface MeasurementDefJson { name: string; externalName?: string }

/**
 * Body -> SeamlyMe measurements XML. Values are in the body's display unit (cm or inch), two
 * decimals. Loads the avatar base model (for the externalName mapping) and the gender statistical
 * model (to complete unmeasured fields) — both cached by the model asset loaders.
 */
export async function bodyToSeamlyMe(body: Body): Promise<string> {
  const [assets, model] = await Promise.all([loadAvatarAssets(), loadGenderModel(body.gender)]);
  const defs = assets.baseModel.measurements as MeasurementDefJson[];
  const full = completeMeasurements(model, toMetricKnown(body));
  const col = (name: string) => model.columnNames.indexOf(name);
  const imperial = body.unitType !== 'metric';
  const toUnit = (cm: number) => Number((imperial ? cm / CM_PER_IN : cm).toFixed(2));

  const out: Record<string, number> = {};
  for (const def of defs) {
    if (!def.externalName) continue;
    const i = col(def.name);
    if (i < 0 || !Number.isFinite(full[i])) continue;
    out[def.externalName] = toUnit(full[i]);
  }
  for (const [target, source] of Object.entries(DERIVED_HALF)) {
    if (out[source] != null) out[target] = Number((out[source] / 2).toFixed(2));
  }
  for (const [target, source] of Object.entries(COPIED)) {
    if (out[source] != null) out[target] = out[source];
  }
  const hi = col('height');
  if (hi >= 0 && Number.isFinite(full[hi])) out.height = toUnit(full[hi]);

  // birth-date: Jan 1 of (current year - age), like the original exporter.
  const ageIdx = col('age');
  const age = body.fields.age ?? (ageIdx >= 0 && Number.isFinite(full[ageIdx]) ? Math.round(full[ageIdx]) : 0);
  const birth = new Date();
  birth.setFullYear(birth.getFullYear() - age);
  birth.setMonth(0);
  birth.setDate(1);
  const birthDate = birth.toISOString().split('T')[0];

  const rows = Object.entries(out).map(([n, v]) => `\t<m name="${n}" value="${v}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<vit>
    <!--Measurements created with BodyDbl.-->
    <version>${SEAMLYME_VERSION}</version>
    <read-only>false</read-only>
    <notes/>
    <unit>${imperial ? 'inch' : 'cm'}</unit>
    <pm_system>998</pm_system>
    <personal>
        <family-name/>
        <given-name/>
        <birth-date>${birthDate}</birth-date>
        <gender>${body.gender}</gender>
        <email/>
    </personal>
    <body-measurements>
${rows}
    </body-measurements>
</vit>`;
}
