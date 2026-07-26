// Body export (the source's BodyDbl export dropdown): measurements as JSON / CSV, and the avatar
// body mesh alone as OBJ / binary STL — built headlessly from the statistical model, no 3D scene
// required. Lengths follow the body's display unit (cm or inch), mirroring the original exporters.

import type { Body } from '@seamer/pattern-model';
import { loadAvatarAssets, loadGenderAssets } from '@seamer/avatar';
import { completeMeasurements, toMetricKnown, solveBodyCoefficients } from '@seamer/avatar';
import { reconstructVertices } from '@seamer/avatar';

const CM_PER_IN = 2.54;

/** Completed measurement map (entered + regressed) in the body's display unit, keyed by field name. */
async function completedFields(body: Body): Promise<Record<string, number>> {
  const { loadGenderModel } = await import('@seamer/avatar');
  const model = await loadGenderModel(body.gender);
  const full = completeMeasurements(model, toMetricKnown(body));
  const imperial = body.unitType !== 'metric';
  const out: Record<string, number> = {};
  model.columnNames.forEach((name, i) => {
    if (!Number.isFinite(full[i])) return;
    if (name === 'age') { out.age = Number(full[i].toFixed(1)); return; }
    if (name === 'weightCbrt') { const kg = Math.pow(full[i], 3); out.weight = Number((imperial ? kg / 0.453592 : kg).toFixed(2)); return; }
    out[name] = Number((imperial ? full[i] / CM_PER_IN : full[i]).toFixed(2));
  });
  return out;
}

/** Measurements as JSON: gender + unit + every completed field (the source's JsonExporter). */
export async function bodyToJson(body: Body): Promise<string> {
  const fields = await completedFields(body);
  return JSON.stringify({ gender: body.gender, unit: body.unitType === 'metric' ? 'cm' : 'inch', ...fields }, null, 4);
}

/** Measurements as CSV: one header row of names, one row of values (the source's CsvExporter). */
export async function bodyToCsv(body: Body): Promise<string> {
  const fields = await completedFields(body);
  const names = ['gender', 'unit', ...Object.keys(fields)];
  const values = [body.gender, body.unitType === 'metric' ? 'cm' : 'inch', ...Object.values(fields)];
  return `${names.join(',')}\n${values.join(',')}`;
}

/** Reconstruct the body mesh (T-pose) headlessly: positions (m) + triangle indices. */
async function buildBodyMesh(body: Body): Promise<{ positions: Float32Array; indices: Uint32Array }> {
  const [assets, gender] = await Promise.all([loadAvatarAssets(), loadGenderAssets(body.gender)]);
  const { coeff } = solveBodyCoefficients(gender.model, body);
  const positions = reconstructVertices(assets.baseModel, gender.coefficients, coeff, assets.numVertices);
  return { positions, indices: assets.indices };
}

/** Body mesh as Wavefront OBJ text. */
export async function bodyToObj(body: Body): Promise<string> {
  const { positions, indices } = await buildBodyMesh(body);
  const lines: string[] = ['# Seamer body export'];
  for (let i = 0; i < positions.length; i += 3) {
    lines.push(`v ${positions[i].toFixed(5)} ${positions[i + 1].toFixed(5)} ${positions[i + 2].toFixed(5)}`);
  }
  for (let i = 0; i < indices.length; i += 3) {
    lines.push(`f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}`);
  }
  return lines.join('\n');
}

/** Body mesh as binary STL. */
export async function bodyToStl(body: Body): Promise<Uint8Array<ArrayBuffer>> {
  const { positions, indices } = await buildBodyMesh(body);
  const triCount = indices.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buf);
  view.setUint32(80, triCount, true);
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
    const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2];
    const bx = positions[i1], by = positions[i1 + 1], bz = positions[i1 + 2];
    const cx = positions[i2], cy = positions[i2 + 1], cz = positions[i2 + 2];
    // facet normal = (b-a) × (c-a), normalised
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const f = [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz];
    for (const value of f) { view.setFloat32(off, value, true); off += 4; }
    view.setUint16(off, 0, true); off += 2;
  }
  return new Uint8Array(buf);
}
