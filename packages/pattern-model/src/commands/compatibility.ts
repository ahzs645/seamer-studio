// Compatibility reducers for commands exposed by the production seamscape.com catalog.

import type {
  AlterationDelta,
  AlterationTrack,
  GradeAnchor,
  GradingProfile,
  Pattern
} from '../pattern';

type Uid = (prefix: string) => string;
type ShiftInput = {
  pointId?: string;
  pointRef?: string;
  dx: number;
  dy: number;
  unit?: string;
};

const emptyDelta = (): AlterationDelta => ({ points: {}, handles: {} });

function lengthScale(unit: unknown): number {
  if (unit === undefined || unit === 'mm') return 1;
  if (unit === 'cm') return 10;
  if (unit === 'in' || unit === 'inch') return 25.4;
  throw new Error(`Unsupported length unit: ${String(unit)}`);
}

function parseShifts(value: unknown): ShiftInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('shifts must be a non-empty array');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`shifts[${index}] must be an object`);
    const row = entry as Record<string, unknown>;
    if (typeof row.dx !== 'number' || !Number.isFinite(row.dx)) throw new Error(`shifts[${index}].dx must be a finite number`);
    if (typeof row.dy !== 'number' || !Number.isFinite(row.dy)) throw new Error(`shifts[${index}].dy must be a finite number`);
    if (row.pointId !== undefined && typeof row.pointId !== 'string') throw new Error(`shifts[${index}].pointId must be a string`);
    if (row.pointRef !== undefined && typeof row.pointRef !== 'string') throw new Error(`shifts[${index}].pointRef must be a string`);
    if (row.pointId === undefined && row.pointRef === undefined) throw new Error(`shifts[${index}] must provide pointId or pointRef`);
    if (row.unit !== undefined && typeof row.unit !== 'string') throw new Error(`shifts[${index}].unit must be a string`);
    return {
      pointId: row.pointId as string | undefined,
      pointRef: row.pointRef as string | undefined,
      dx: row.dx,
      dy: row.dy,
      unit: row.unit as string | undefined
    };
  });
}

function boundaryPointIds(pattern: Pattern, pieceId: string): Set<string> {
  const piece = pattern.pieces.find((candidate) => candidate.id === pieceId);
  if (!piece) throw new Error(`Piece not found: ${pieceId}`);
  const pathById = new Map(pattern.paths.map((path) => [path.id, path]));
  const ids = new Set<string>();
  for (const piecePath of piece.mainPaths) {
    ids.add(piecePath.from);
    ids.add(piecePath.to);
    for (const point of pathById.get(piecePath.path)?.pathPoints ?? []) ids.add(point.id);
  }
  return ids;
}

function resolvePoint(pattern: Pattern, shift: ShiftInput, index: number) {
  if (shift.pointId) {
    const point = pattern.points.find((candidate) => candidate.id === shift.pointId);
    if (!point) throw new Error(`Point not found: ${shift.pointId}`);
    return point;
  }
  const ref = shift.pointRef?.trim().toLowerCase() ?? '';
  const matches = pattern.points.filter((point) =>
    [point.id, point.name, point.label]
      .some((value) => typeof value === 'string' && value.trim().toLowerCase() === ref)
  );
  if (matches.length === 0) throw new Error(`Point not found by reference: ${shift.pointRef ?? ''}`);
  if (matches.length > 1) throw new Error(`Point reference is ambiguous: ${shift.pointRef ?? ''}`);
  if (!ref) throw new Error(`shifts[${index}].pointRef cannot be empty`);
  return matches[0];
}

function currentDriverValue(pattern: Pattern, variableId: string): number {
  const variable = pattern.variables.find((candidate) => candidate.id === variableId);
  if (!variable) throw new Error(`Driver variable not found: ${variableId}`);
  const value = typeof variable.overrideValue === 'number' ? variable.overrideValue : variable.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Driver variable has no numeric value: ${variableId}`);
  }
  return value;
}

function upsertAnchor(
  anchors: GradeAnchor[],
  driverValue: number,
  name: string,
  geometry: AlterationDelta,
  uid: Uid
): GradeAnchor[] {
  const existing = anchors.find((anchor) =>
    anchor.name.trim().toLowerCase() === name.trim().toLowerCase()
  );
  const next: GradeAnchor = {
    id: existing?.id ?? uid('anchor'),
    name,
    driverValue,
    categories: existing?.categories ?? {},
    geometry
  };
  return existing
    ? anchors.map((anchor) => anchor.id === existing.id ? next : anchor)
    : [...anchors, next];
}

function upsertTrack(
  tracks: AlterationTrack[],
  variableId: string,
  driverValue: number,
  delta: AlterationDelta,
  uid: Uid
): AlterationTrack[] {
  const existing = tracks.find((track) => track.driverVariableId === variableId);
  const sample = {
    id: existing?.samples.find((candidate) => Math.abs(candidate.driverValue - driverValue) <= 1e-6)?.id ?? uid('alterationSample'),
    driverValue,
    deltaGeometry: delta
  };
  if (!existing) {
    return [...tracks, {
      id: uid('alterationTrack'),
      name: 'Point-shift grading',
      enabled: true,
      driverVariableId: variableId,
      samples: [sample]
    }];
  }
  const samples = existing.samples.some((candidate) => Math.abs(candidate.driverValue - driverValue) <= 1e-6)
    ? existing.samples.map((candidate) => Math.abs(candidate.driverValue - driverValue) <= 1e-6 ? sample : candidate)
    : [...existing.samples, sample];
  samples.sort((a, b) => a.driverValue - b.driverValue);
  return tracks.map((track) => track.id === existing.id ? { ...track, enabled: true, samples } : track);
}

/**
 * Apply point shifts and optionally capture the delta as an alteration sample/anchor. When a target
 * driver value is supplied, the base geometry remains stored in Pattern and the solver activates
 * the captured delta from the driver, matching the production command's restore-baseline behavior.
 */
export function gradingApplyPointShifts(
  pattern: Pattern,
  params: Record<string, unknown>,
  uid: Uid
): Pattern {
  if (typeof params.pieceId !== 'string') throw new Error('pieceId must be a string');
  const shifts = parseShifts(params.shifts);
  const boundary = boundaryPointIds(pattern, params.pieceId);
  const allowConstruction = params.allowConstructionPoints === true;
  const allowSliding = params.allowSlidingPoints === true;
  const defaultUnit = params.unit;
  const totals = new Map<string, { dx: number; dy: number }>();
  for (let index = 0; index < shifts.length; index += 1) {
    const shift = shifts[index];
    const point = resolvePoint(pattern, shift, index);
    if (!allowConstruction && !boundary.has(point.id)) {
      throw new Error(`Point ${point.name || point.id} is not part of the selected piece boundary`);
    }
    const sliding = pattern.paths.some((path) => path.slidingPoints?.some((candidate) => candidate.id === point.id));
    if (!allowSliding && sliding) throw new Error(`Point ${point.name || point.id} is a sliding point`);
    const scale = lengthScale(shift.unit ?? defaultUnit);
    const current = totals.get(point.id) ?? { dx: 0, dy: 0 };
    totals.set(point.id, { dx: current.dx + shift.dx * scale, dy: current.dy + shift.dy * scale });
  }

  const delta = emptyDelta();
  for (const [id, value] of totals) delta.points[id] = { x: value.dx, y: value.dy };
  const capture = params.captureAnchor !== false;
  const driverVariableId = typeof params.driverVariableId === 'string'
    ? params.driverVariableId
    : pattern.gradingProfile?.mainDriverVariableId ?? null;
  const targetDriver = typeof params.driverValue === 'number' && Number.isFinite(params.driverValue)
    ? params.driverValue
    : null;
  const restoreBase = capture && targetDriver !== null;
  const points = restoreBase
    ? pattern.points
    : pattern.points.map((point) => {
        const value = totals.get(point.id);
        return value ? { ...point, x: point.x + value.dx, y: point.y + value.dy } : point;
      });
  if (!capture) return { ...pattern, points, hasChanged: true };
  if (!driverVariableId) throw new Error('driverVariableId is required when captureAnchor is enabled');

  const baseDriver = currentDriverValue(pattern, driverVariableId);
  const driverValue = targetDriver ?? baseDriver;
  const profile: GradingProfile = pattern.gradingProfile ?? { sizes: [] };
  let anchors = profile.anchors ?? [];
  if (targetDriver !== null && Math.abs(targetDriver - baseDriver) > 1e-6) {
    anchors = upsertAnchor(anchors, baseDriver, 'Baseline', emptyDelta(), uid);
  }
  const anchorName = typeof params.anchorName === 'string' && params.anchorName.trim()
    ? params.anchorName.trim()
    : `Anchor ${anchors.length + 1}`;
  anchors = upsertAnchor(anchors, driverValue, anchorName, delta, uid);
  const alterationTracks = upsertTrack(
    profile.alterationTracks ?? [],
    driverVariableId,
    driverValue,
    delta,
    uid
  );
  return {
    ...pattern,
    points,
    gradingProfile: {
      ...profile,
      mainDriverVariableId: driverVariableId,
      anchors,
      alterationTracks
    },
    hasChanged: true
  };
}

function applyAnchorGeometry(pattern: Pattern, anchor: GradeAnchor): Pattern {
  const points = pattern.points.map((point) => {
    const delta = anchor.geometry.points[point.id];
    return delta ? { ...point, x: point.x + delta.x, y: point.y + delta.y } : point;
  });
  const paths = pattern.paths.map((path) => ({
    ...path,
    pathPoints: path.pathPoints.map((point) => {
      const delta = anchor.geometry.handles[`${path.id}:${point.id}`];
      if (!delta || !point.handle) return point;
      return {
        ...point,
        handle: {
          ...point.handle,
          v1: { x: point.handle.v1.x + delta.v1.x, y: point.handle.v1.y + delta.v1.y },
          v2: { x: point.handle.v2.x + delta.v2.x, y: point.handle.v2.y + delta.v2.y }
        }
      };
    })
  }));
  return { ...pattern, points, paths };
}

/** Restore a selected/inferred grading anchor and remove Freeform Parametrics state. */
export function gradingClearProfile(pattern: Pattern, params: Record<string, unknown>): Pattern {
  const profile = pattern.gradingProfile;
  if (!profile) return pattern;
  if (params.keepCurrentGeometry === true) return { ...pattern, gradingProfile: null, hasChanged: true };
  if (params.restoreAnchorId !== undefined && params.restoreDriverValue !== undefined) {
    throw new Error('Use either restoreAnchorId or restoreDriverValue, not both');
  }
  const anchors = profile.anchors ?? [];
  let matches: GradeAnchor[];
  if (typeof params.restoreAnchorId === 'string') {
    matches = anchors.filter((anchor) => anchor.id === params.restoreAnchorId);
  } else if (typeof params.restoreDriverValue === 'number' && Number.isFinite(params.restoreDriverValue)) {
    const restoreDriverValue = params.restoreDriverValue;
    matches = anchors.filter((anchor) => Math.abs(anchor.driverValue - restoreDriverValue) <= 1e-6);
  } else {
    const named = anchors.filter((anchor) => anchor.name.trim().toLowerCase() === 'baseline');
    matches = named.length ? named : anchors.filter((anchor) => Math.abs(anchor.driverValue) <= 1e-6);
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? 'No unambiguous baseline grading anchor found'
      : 'Multiple grading anchors match; provide restoreAnchorId');
  }
  const restored = applyAnchorGeometry(pattern, matches[0]);
  return { ...restored, gradingProfile: null, hasChanged: true };
}

/** Update mirror constraints on an embedded Bezier handle. */
export function handleUpdate(
  pattern: Pattern,
  handleId: string,
  sameLength: unknown,
  sameAngle: unknown
): Pattern {
  if (sameLength === undefined && sameAngle === undefined) {
    throw new Error('Provide at least one handle field to update');
  }
  if (sameLength !== undefined && typeof sameLength !== 'boolean') throw new Error('sameLength must be a boolean');
  if (sameAngle !== undefined && typeof sameAngle !== 'boolean') throw new Error('sameAngle must be a boolean');
  let found = false;
  const paths = pattern.paths.map((path) => ({
    ...path,
    pathPoints: path.pathPoints.map((point) => {
      if (!point.handle) return point;
      const matches = point.handle.id === handleId
        || point.id === handleId
        || `${path.id}:${point.id}` === handleId;
      if (!matches) return point;
      found = true;
      return {
        ...point,
        handle: {
          ...point.handle,
          ...(typeof sameLength === 'boolean' ? { sameLength } : {}),
          ...(typeof sameAngle === 'boolean' ? { sameAngle } : {})
        }
      };
    })
  }));
  if (!found) throw new Error(`Handle not found: ${handleId}`);
  return { ...pattern, paths, hasChanged: true };
}
