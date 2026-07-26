// Measurement processing for avatar shape reconstruction.
//
// Pipeline:
//   1. Convert the user's body.fields to the model's metric space (cm / kg / years) and map
//      weight -> weightCbrt (the column the statistical model uses).
//   2. Complete the missing measurements via conditional-Gaussian regression on the gender model
//      (E[x_o | x_I] = mu_o + Sigma_oI Sigma_II^-1 (x_I - mu_I)), one single-output solve per
//      missing column.
//   3. Build the 17-element coefficient vector (in COEFFICIENT_NAMES order) that drives per-vertex
//      reconstruction, deriving weightHeightSqrtRatio = sqrt(weightKg / heightCm).

import type { GenderModel } from './assets';
import { COLUMN_NAMES, COEFFICIENT_NAMES } from './measurementDefs';
import type { Body } from '@seamer/pattern-model';
import { invert, matVec, dot } from './matrix';

const LB_TO_KG = 0.453592;
const IN_TO_CM = 2.54;

/** Known measurements expressed in the model's column space (metric). Map columnName -> value. */
export function toMetricKnown(body: Body): Map<string, number> {
  const imperial = body.unitType !== 'metric';
  const known = new Map<string, number>();
  for (const [name, raw] of Object.entries(body.fields)) {
    if (raw == null || Number.isNaN(raw)) continue;
    if (name === 'age') {
      known.set('age', raw);
    } else if (name === 'weight') {
      const kg = imperial ? raw * LB_TO_KG : raw;
      known.set('weightCbrt', Math.cbrt(kg));
    } else {
      const cm = imperial ? raw * IN_TO_CM : raw;
      known.set(name, cm);
    }
  }
  return known;
}

/**
 * Complete all 69 columns from the known subset using the gender model. Returns values in
 * COLUMN_NAMES order. Known columns are passed through; missing columns are regressed.
 */
export function completeMeasurements(model: GenderModel, known: Map<string, number>): number[] {
  const cols = model.columnNames;
  const idx = (name: string) => cols.indexOf(name);

  const knownIdx: number[] = [];
  const knownVals: number[] = [];
  for (const [name, val] of known) {
    const i = idx(name);
    if (i >= 0) { knownIdx.push(i); knownVals.push(val); }
  }

  const out = model.means.slice(); // default to mean
  for (const [name, val] of known) {
    const i = idx(name);
    if (i >= 0) out[i] = val;
  }

  if (knownIdx.length === 0) return out; // nothing known -> mean body

  // Sigma_II (k x k) and its inverse, shared across all missing columns.
  const k = knownIdx.length;
  const sigmaII: number[][] = [];
  for (let a = 0; a < k; a++) {
    const row: number[] = [];
    for (let b = 0; b < k; b++) row.push(model.covariances[knownIdx[a]][knownIdx[b]]);
    sigmaII.push(row);
  }
  const inv = invert(sigmaII);
  const knownMeans = knownIdx.map((i) => model.means[i]);
  const knownDelta = knownVals.map((v, i) => v - knownMeans[i]);

  if (!inv) {
    // Singular: keep known values, leave the rest at the mean.
    return out;
  }
  const invDelta = matVec(inv, knownDelta); // Sigma_II^-1 (x_I - mu_I)

  for (let o = 0; o < cols.length; o++) {
    if (knownIdx.includes(o)) continue;
    const sigmaOI = knownIdx.map((i) => model.covariances[o][i]);
    out[o] = model.means[o] + dot(sigmaOI, invDelta);
  }
  return out;
}

/** Build the 17-element coefficient vector (COEFFICIENT_NAMES order) for vertex reconstruction. */
export function coefficientVector(full: number[]): number[] {
  const get = (name: string): number => {
    const i = COLUMN_NAMES.indexOf(name);
    return i >= 0 ? full[i] : 0;
  };
  const heightCm = get('height');
  const weightKg = Math.pow(get('weightCbrt'), 3);

  return COEFFICIENT_NAMES.map((name) => {
    if (name === 'weightHeightSqrtRatio') {
      return heightCm > 0 ? Math.sqrt(weightKg / heightCm) : 0;
    }
    return get(name);
  });
}

/** Convenience: body -> { coefficient vector (17), completed metric measurements (69) }. */
export function solveBodyCoefficients(model: GenderModel, body: Body): { coeff: number[]; full: number[] } {
  const known = toMetricKnown(body);
  const full = completeMeasurements(model, known);
  return { coeff: coefficientVector(full), full };
}
