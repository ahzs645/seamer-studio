/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cubicAt, indexPoints, pathSegments } from '@seamer/pattern-model/utils/patternGeometry';
import { buildPieceCloth, computeSeamEdgeIntervals } from '@seamer/cloth-sim';
import { isGarmentCodeFormat, convertGarmentCodePattern } from './importGarmentCode';
import { assertPatternBuildable3d } from './importSimplePattern';
import { activeGarmentCodeBody } from '@seamer/avatar';

function square() {
  return { pattern: { panels: { front: {
    vertices: [[0,0], [10,0], [10,10], [0,10]],
    edges: [{ endpoints: [0,1] }, { endpoints: [1,2] }, { endpoints: [2,3] }, { endpoints: [3,0] }],
    rotation: [0,0,0], translation: [0,100,20]
  } }, stitches: [] as unknown[] }, properties: { units_in_meter: 100, curvature_coords: 'relative' } };
}
function curved(curvature: unknown, absolute = false) {
  const value = square();
  Object.assign(value.pattern.panels.front.edges[0], { curvature });
  if (absolute) value.properties.curvature_coords = 'absolute';
  return convertGarmentCodePattern(value);
}

describe('GarmentCode conversion', () => {
  it('preserves bounded semantic panel labels and rejects malformed labels', () => {
    const value = square();
    Object.assign(value.pattern.panels.front, { label: 'arm' });
    expect(convertGarmentCodePattern(value).pieces[0].label).toBe('arm');
    for (const label of [42, {}, 'x'.repeat(501)]) {
      Object.assign(value.pattern.panels.front, { label });
      expect(() => convertGarmentCodePattern(value)).toThrow(/panel label/);
    }
  });
  it('retains resolved generator measurements and signs the matched avatar fields', () => {
    const value = square();
    const measurements = { height: 171.99, head_l: 26.3262, waist_line: 36.8913, hips_line: 23.4837,
      shoulder_w: 36.4568, shoulder_incl: 21.6777, arm_pose_angle: 45.483, bust: 99.8407,
      waist: 84.3338, hips: 103.478, arm_length: 53.9697 };
    Object.assign(value.properties, { garmentcode_body: measurements });
    const pattern = convertGarmentCodePattern(value);
    expect(pattern.body.unitType).toBe('metric');
    expect(pattern.body.fields.height).toBe(171.99);
    expect(pattern.body.fields.chestGirth).toBe(99.8407);
    expect(activeGarmentCodeBody(pattern.body)).toEqual(measurements);
    expect(pattern.garmentCodeSource?.properties.garmentcode_body).toEqual(measurements);
    expect(activeGarmentCodeBody({ ...pattern.body, fields: { ...pattern.body.fields, height: 180 } })).toBeNull();
    Object.assign(value.properties, { garmentcode_body: { ...measurements, height: -1 } });
    expect(() => convertGarmentCodePattern(value)).toThrow(/GarmentCode body/);
    expect(convertGarmentCodePattern(square()).body.garmentCodeBody).toBeUndefined();
  });
  it('uses only explicit supported source leg poses for body calibration', () => {
    const value = square();
    Object.assign(value.properties, { garmentcode_body: {
      height: 176, head_l: 26, waist_line: 37, hips_line: 23,
      shoulder_w: 37, shoulder_incl: 21
    }, garmentcode_body_pose: 'apart' });
    const pattern = convertGarmentCodePattern(value);
    expect(pattern.body.garmentCodeBody?.legPose).toBe('apart');
    expect(pattern.garmentCodeSource?.properties.garmentcode_body_pose).toBe('apart');
    Object.assign(value.properties, { garmentcode_body_pose: 'unsupported' });
    expect(() => convertGarmentCodePattern(value)).toThrow(/source body pose/);
    Object.assign(value.properties, { garmentcode_body_pose: undefined });
    expect(convertGarmentCodePattern(value).body.garmentCodeBody?.legPose).toBe('straight');
  });
  it('detects the panel schema without mistaking native or simple exports', () => {
    expect(isGarmentCodeFormat(square())).toBe(true);
    for (const value of [null, [], { pieces: [] }, { pattern: { panels: [] } }, { panels: {} }]) expect(isGarmentCodeFormat(value)).toBe(false);
  });
  it('converts source units once and retains source placement independently of 2D layout', () => {
    const value = square(); value.properties.units_in_meter = 300;
    const pattern = convertGarmentCodePattern(value, 'My tee');
    expect(pattern.name).toBe('My tee');
    expect(pattern.lengthUnit).toBe('mm');
    const [a, b] = pattern.points;
    expect(b.x - a.x).toBeCloseTo(100 / 3);
    const source = pattern.pieces[0].settings3d.arrangement.sourcePlacement!;
    expect(source.worldMatrix.slice(12,15)).toEqual([0, 1/3, 20/300]);
    expect(a.x - source.layoutOffsetMm.x).toBe(0);
    expect(a.y - source.layoutOffsetMm.y).toBe(0);
    expect(pattern.pieces[0].settings3d.savedPositions).toEqual([]);
  });
  it('keeps anchors unique across overlapping source panels', () => {
    const value = square(); Object.assign(value.pattern.panels, { back: structuredClone(value.pattern.panels.front) });
    const pattern = convertGarmentCodePattern(value);
    const first = new Set(pattern.pieces[0].mainPaths.flatMap((pp) => [pp.from,pp.to]));
    expect(pattern.pieces[1].mainPaths.every((pp) => !first.has(pp.from) && !first.has(pp.to))).toBe(true);
  });
  it('preserves the outside sign of clockwise and counterclockwise source panels', () => {
    const ccw = square();
    expect(convertGarmentCodePattern(ccw).pieces[0].settings3d.flipNormals).toBe(false);
    ccw.pattern.panels.front.vertices.reverse();
    expect(convertGarmentCodePattern(ccw).pieces[0].settings3d.flipNormals).toBe(true);
  });
  it.each([[0.5,0.2], { type: 'quadratic', params: [[0.5,0.2]] }])('elevates quadratic %j to exact editable cubic handles', (curve) => {
    const pattern = curved(curve);
    const segment = pathSegments(pattern.paths[0], indexPoints(pattern))[0];
    const mid = cubicAt(segment,0.5);
    expect(mid.x - segment.a.x).toBeCloseTo(50);
    expect(mid.y - segment.a.y).toBeCloseTo(10);
    expect(segment.c1.y - segment.a.y).toBeCloseTo(40 / 3);
  });
  it('retains typed cubic control coordinates in the source edge frame', () => {
    const pattern = curved({ type: 'cubic', params: [[0.2,-0.3],[0.8,0.4]] });
    const s = pathSegments(pattern.paths[0],indexPoints(pattern))[0];
    expect(s.c1.x - s.a.x).toBeCloseTo(20); expect(s.c1.y - s.a.y).toBeCloseTo(-30);
    expect(s.c2.x - s.a.x).toBeCloseTo(80); expect(s.c2.y - s.a.y).toBeCloseTo(40);
  });
  it('supports absolute control coordinates without treating them as relative fractions', () => {
    const pattern = curved({ type: 'quadratic', params: [[5,2]] }, true);
    const s = pathSegments(pattern.paths[0],indexPoints(pattern))[0];
    expect(cubicAt(s,0.5).y - s.a.y).toBeCloseTo(10);
  });
  it.each([[0,0],[0,1],[1,0],[1,1]])('preserves SVG circle large=%s sweep=%s with editable arc metadata', (large,sweep) => {
    const pattern = curved({ type: 'circle', params: [10,large,sweep] });
    const path = pattern.paths[0], arc = path.arc!;
    const angle = arc.a1 - arc.a0;
    expect(Math.sign(angle)).toBe(sweep ? 1 : -1);
    expect(Math.abs(angle) > Math.PI).toBe(Boolean(large));
    expect(arc.r).toBe(100);
    const anchors = path.pathPoints.map((pp) => indexPoints(pattern).get(pp.id)!);
    anchors.forEach((anchor) => expect(Math.hypot(anchor.x-arc.cx,anchor.y-arc.cy)).toBeCloseTo(arc.r));
    expect(anchors[0].x).toBe(50); expect(anchors.at(-1)!.x).toBe(150);
  });
  it('honors source radius expansion for arcs whose chord exceeds the diameter', () => {
    expect(curved({ type: 'circle', params: [1,0,1] }).paths[0].arc!.r).toBe(50);
  });
  it('preserves explicit ordinary and right_wrong orientations, including same-panel darts', () => {
    const value = square();
    value.pattern.stitches = [[{ panel:'front',edge:0 }, { panel:'front',edge:1 }], [{ panel:'front',edge:2 }, { panel:'front',edge:3 }, 'right_wrong']];
    const pattern = convertGarmentCodePattern(value);
    expect(pattern.seams.map((s) => s.toPaths[0].reversed)).toEqual([true,false]);
    expect(pattern.seams.every((s) => s.explicitOrientation)).toBe(true);
    expect(pattern.seams[0].fromPaths[0].id).toBe(pattern.pieces[0].mainPaths[0].id);
  });
  it('retains a detached copy of source parameters as provenance', () => {
    const value = { ...square(), parameters: { sleeve: { value: 12 } }, parameter_order: ['sleeve'] };
    const pattern = convertGarmentCodePattern(value);
    value.parameters.sleeve.value = 99;
    expect(pattern.garmentCodeSource!.parameters).toEqual({ sleeve: { value:12 } });
    expect(pattern.variables).toEqual([]);
  });
  it('frames offset garment geometry in world space rather than its drafting grid', () => {
    const value = square(); value.pattern.panels.front.translation=[150,150,0];
    const pattern = convertGarmentCodePattern(value);
    expect(pattern.settings3d.controlsTarget[0]).toBeGreaterThan(0.5);
    expect(pattern.settings3d.controlsTarget[0]).toBeLessThan(1);
    expect(pattern.settings3d.cameraPosition[2]).toBeGreaterThan(3);
    expect(pattern.settings3d.cameraPosition.every(Number.isFinite)).toBe(true);
    expect(pattern.settings3d.sourceCameraFraming).toBe('viewport');
  });
  it.each([
    ['missing units', (x: ReturnType<typeof square>) => { delete (x.properties as Record<string,unknown>).units_in_meter; }, /units_in_meter/],
    ['zero units', (x: ReturnType<typeof square>) => { x.properties.units_in_meter=0; }, /positive/],
    ['nonfinite units', (x: ReturnType<typeof square>) => { x.properties.units_in_meter=Infinity; }, /finite/],
    ['nonfinite vertex', (x: ReturnType<typeof square>) => { x.pattern.panels.front.vertices[0][0]=NaN; }, /finite/],
    ['vertex reference', (x: ReturnType<typeof square>) => { x.pattern.panels.front.edges[0].endpoints[0]=99; }, /vertex reference/],
    ['open boundary', (x: ReturnType<typeof square>) => { x.pattern.panels.front.edges[1].endpoints=[2,1]; }, /closed boundary/],
    ['bad stitch', (x: ReturnType<typeof square>) => { x.pattern.stitches=[[{ panel:'missing',edge:0 }, { panel:'front',edge:0 }]]; }, /missing panel/],
    ['duplicate stitch', (x: ReturnType<typeof square>) => { x.pattern.stitches=[[{ panel:'front',edge:0 }, { panel:'front',edge:0 }]]; }, /more than once/],
    ['unknown stitch orientation', (x: ReturnType<typeof square>) => { x.pattern.stitches=[[{ panel:'front',edge:0 }, { panel:'front',edge:1 },'mystery']]; }, /right_wrong/],
    ['normalization required', (x: ReturnType<typeof square>) => { Object.assign(x.properties,{ normalize_panel_translation:true }); }, /upstream normalization/]
  ] as const)('rejects %s before changing the document', (_name, mutate, message) => {
    const value = square(); mutate(value); expect(() => convertGarmentCodePattern(value)).toThrow(message);
  });
  it.each([
    { type:'unsupported',params:[] }, { type:'cubic',params:[[0.5,0.2]] }, { type:'circle',params:[0,0,0] },
    { type:'circle',params:[10,2,0] }, { type:'circle',params:[1e308,0,0] }, [NaN,0.5]
  ])('rejects invalid curve %j', (curve) => expect(() => curved(curve)).toThrow(/Invalid GarmentCode/));

  const fixtures = [
    ['dress_pencil_specification.json','../../../static/examples/garmentcode/'],
    ['hoody_mean_specification.json','../../../static/examples/garmentcode/'],
    ['shirt_mean_specification.json','../../../static/examples/garmentcode/'],
    ['js_mean_all_specification.json','../../../static/examples/garmentcode/'],
    ['legacy-tee.json','./fixtures/garmentcode/'],
    ['legacy-skirt.json','./fixtures/garmentcode/']
  ];
  it.each(fixtures)('imports and triangulates every panel in the real MIT example %s', (file, prefix) => {
    const source = JSON.parse(readFileSync(new URL(`${prefix}${file}`,import.meta.url),'utf8'));
    const pattern = convertGarmentCodePattern(source,file);
    expect(pattern.pieces.length).toBe(Object.keys(source.pattern.panels).length);
    expect(pattern.seams.length).toBe(source.pattern.stitches.length);
    expect(() => assertPatternBuildable3d(pattern)).not.toThrow();
    const intervals = computeSeamEdgeIntervals(pattern);
    for (const piece of pattern.pieces) {
      const cloth = buildPieceCloth(pattern,piece,undefined,intervals);
      expect(cloth).not.toBeNull();
      expect(cloth!.mesh.points.length).toBeGreaterThan(3);
      expect(cloth!.mesh.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    }
  });
});
