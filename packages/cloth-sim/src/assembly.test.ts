import { describe, expect, it } from 'vitest';
import { createEmptyPattern, type Piece, type Seam } from '@seamer/pattern-model';
import { attachGarmentCodeBody } from '@seamer/avatar';
import { AssemblySupportController, bodyUpperEnvelopeSpan, bodyUpperEnvelopeY, prepareGarmentCodeAssembly, type AssemblySupportData } from './assembly';
import { buildBodySurfaceBVH } from './webgpu/bodySurfaceBroadphase';
import type { SimData } from './build';
import type { BodyMesh } from './webgpu/engine';

const body: BodyMesh = { positions: new Float32Array([
  -1, 1.5, -0.2, 0, 1, 1.5, -0.2, 0, 1, 1.5, 0.2, 0, -1, 1.5, 0.2, 0
]), triangles: new Uint32Array([0, 1, 2, 0, 0, 2, 3, 0]), numTriangles: 2 };

function fixture() {
  const pattern = createEmptyPattern();
  pattern.body = attachGarmentCodeBody(pattern.body, { height: 176, head_l: 26, waist_line: 37,
    hips_line: 23, shoulder_w: 36, shoulder_incl: 20 });
  pattern.garmentCodeSource = { format: 'garmentcode-json', unitsInMeter: 100, properties: {}, panelNames: ['front', 'back', 'waist'] };
  const placement = { worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], layoutOffsetMm: { x: 0, y: 0 } };
  pattern.pieces = ['front', 'back', 'waist'].map(id => ({ id, name: id, mainPaths: id === 'waist'
    ? [{ id: 'waistEdge', name: 'lower_interface' }]
    : [{ id: `${id}neck`, name: 'collar' }, { id: `${id}shoulder`, name: '' }, { id: `${id}arm`, name: 'armhole' }],
    settings3d: { arrangement: { sourcePlacement: structuredClone(placement) } } } as Piece));
  pattern.seams = [{ id: 'shoulder', fromPaths: [{ id: 'frontshoulder' }], toPaths: [{ id: 'backshoulder' }] },
    { id: 'waistJoin', fromPaths: [{ id: 'waistEdge' }], toPaths: [{ id: 'frontarm' }] }] as Seam[];
  const positions = new Float32Array([0.15, 1.48, 0.3, 1, 0.15, 1.48, -0.3, 1, 0, 1.02, 0.2, 1]);
  const data = { positions: positions.slice(), arrangedPositions: positions.slice(), particleCount: 3,
    pieces: [{ pieceId: 'front', start: 0, count: 1 }, { pieceId: 'back', start: 1, count: 1 }, { pieceId: 'waist', start: 2, count: 1 }],
    seamPairsBySeam: [{ seamId: 'shoulder', pairs: [0, 1] }, { seamId: 'waistJoin', pairs: [2, 0] }],
    edgeRuns: new Map([['waist::waistEdge', [2]]]) } as unknown as SimData;
  return { pattern, data };
}

describe('source garment assembly', () => {
  it('uses the actual skin cap and returns no cap outside the body', () => {
    expect(bodyUpperEnvelopeY(body, 0.15, -0.3, 0.3)).toBeCloseTo(1.5);
    expect(bodyUpperEnvelopeY(body, 2, -0.3, 0.3)).toBe(-Infinity);
    expect(bodyUpperEnvelopeY(body, 0.15, 0.5, 0.8)).toBe(-Infinity);
  });
  it('lifts source shoulder panels above skin without changing source transforms or X/Z/mass', () => {
    const { pattern, data } = fixture();
    const source = JSON.stringify(pattern);
    const original = data.positions.slice();
    prepareGarmentCodeAssembly(pattern, data, body, true);
    expect(JSON.stringify(pattern)).toBe(source);
    expect(data.positions[1]).toBeCloseTo(1.508, 6);
    expect(data.positions[5]).toBeCloseTo(1.508, 6);
    for (const offset of [0, 2, 3, 4, 6, 7]) expect(data.positions[offset]).toBe(original[offset]);
    expect(data.positions[9]).toBeCloseTo(1.13);
    expect(data.sourceArrangedPositions).toEqual(original);
    expect(data.assemblySupport?.targets[8]).toBeCloseTo(1.13);
    expect(data.assemblySupport?.groups.map(group => group.kind)).toEqual(['shoulder', 'waist']);
  });
  it('aligns the initial waistband with its semantic waist target and retains the raw flat seed separately', () => {
    const { pattern, data } = fixture();
    prepareGarmentCodeAssembly(pattern, data, body, true);
    expect(data.assemblySupport?.targets[8]).toBeCloseTo((176 - 26 - 37) / 100);
    expect(data.positions[9]).toBeCloseTo(1.13);
    expect(data.arrangedPositions[9]).toBeCloseTo(1.13);
    expect(data.sourceArrangedPositions?.[9]).toBeCloseTo(1.02);
  });
  it('moves the whole waistband/lower component coherently and maps torso hems without lowering shoulders', () => {
    const { pattern, data } = fixture();
    pattern.pieces.push({ ...structuredClone(pattern.pieces[2]), id: 'lower', name: 'lower', mainPaths: [] });
    pattern.seams = [
      { id: 'shoulder', fromPaths: [{ id: 'frontshoulder' }], toPaths: [{ id: 'backshoulder' }] },
      { id: 'upperFront', fromPaths: [{ id: 'waistEdge' }], toPaths: [{ id: 'frontarm' }] },
      { id: 'upperBack', fromPaths: [{ id: 'waistEdge' }], toPaths: [{ id: 'backarm' }] },
      { id: 'lowerJoin', fromPaths: [{ id: 'waistEdge' }], toPaths: [] }
    ] as Seam[];
    data.positions = new Float32Array([
      .15, 1.48, .3, 1, .1, .95, .3, 1, .15, 1.48, -.3, 1, .1, .95, -.3, 1,
      0, 1.02, .2, 1, 0, .98, .2, 1, 0, .92, .25, 1, 0, .5, .25, 1
    ]);
    data.arrangedPositions = data.positions.slice(); data.particleCount = 8;
    data.pieces = ['front', 'back', 'waist', 'lower'].map((pieceId, i) => ({ pieceId, start: i * 2, count: 2 })) as SimData['pieces'];
    data.seamPairsBySeam = [{ seamId: 'shoulder', index: 0, pairs: [0, 2] },
      { seamId: 'upperFront', index: 1, pairs: [1, 4] }, { seamId: 'upperBack', index: 2, pairs: [3, 4] },
      { seamId: 'lowerJoin', index: 3, pairs: [5, 6] }];
    data.edgeRuns = new Map([['waist::waistEdge', [4]]]);
    const raw = data.positions.slice();
    prepareGarmentCodeAssembly(pattern, data, body, true);
    expect(data.positions[1]).toBeCloseTo(1.508, 6);
    expect(data.positions[9]).toBeCloseTo(1.508, 6);
    expect(data.positions[5]).toBeCloseTo(1.13, 6);
    expect(data.positions[13]).toBeCloseTo(1.13, 6);
    expect(data.positions[17]).toBeCloseTo(1.13, 6);
    expect(data.positions[21]).toBeCloseTo(1.09, 6);
    expect(data.positions[25]).toBeCloseTo(1.09, 6);
    expect(data.positions[29]).toBeCloseTo(.67, 6);
    expect(data.sourceArrangedPositions).toEqual(raw);
    expect([...data.positions].every(Number.isFinite)).toBe(true);
  });
  it('keeps a reused checkpoint unchanged and its support inactive', () => {
    const { pattern, data } = fixture();
    const original = data.positions.slice();
    prepareGarmentCodeAssembly(pattern, data, body, false);
    expect(data.positions).toEqual(original);
    expect(data.assemblySupport?.activeOnStart).toBe(false);
    const controller = new AssemblySupportController(data.assemblySupport!, 0.016);
    expect(controller.states.every(state => state.phase === 'released')).toBe(true);
    expect([...controller.targets].filter((_, index) => index % 4 === 1).every(weight => weight === 0)).toBe(true);
  });
  it.each(['native', 'stale-body', 'no-source-placement'])('does not alter %s arrangements', mode => {
    const { pattern, data } = fixture();
    if (mode === 'native') delete pattern.garmentCodeSource;
    if (mode === 'stale-body') pattern.body.fields.height += 1;
    if (mode === 'no-source-placement') for (const piece of pattern.pieces) delete piece.settings3d.arrangement.sourcePlacement;
    const original = data.positions.slice();
    prepareGarmentCodeAssembly(pattern, data, body, true);
    expect(data.positions).toEqual(original);
    expect(data.assemblySupport).toBeUndefined();
  });
});

describe('measured support release', () => {
  const support = (): AssemblySupportData => ({ revision: 1, activeOnStart: true,
    targets: new Float32Array([1.5, 1, 0, 0, 1.5, 1, 0, 0]),
    groups: [{ id: 'shoulder', kind: 'shoulder', particles: [0, 1], seamPairs: [0, 1], releaseGapM: 0.006 }] });
  it('never releases open seams because time elapsed', () => {
    const controller = new AssemblySupportController(support(), 0.1);
    for (let i = 0; i < 200; i++) controller.advance(new Float32Array([0, 1.5, 0.1, 1, 0, 1.5, -0.1, 1]));
    expect(controller.states[0].phase).toBe('assembling');
    expect(controller.states[0].scale).toBe(1);
  });
  it('requires consecutive closed frames and fades to fully free Y support in simulated time', () => {
    const controller = new AssemblySupportController(support(), 0.1);
    const closed = new Float32Array([0, 1.5, 0, 1, 0, 1.5, 0.004, 1]);
    const open = new Float32Array([0, 1.5, 0, 1, 0, 1.5, 0.1, 1]);
    controller.advance(closed); controller.advance(closed); controller.advance(open);
    expect(controller.states[0].stableFrames).toBe(0);
    controller.advance(closed); controller.advance(closed);
    expect(controller.states[0].phase).toBe('assembling');
    controller.advance(closed);
    expect(controller.states[0].phase).toBe('releasing');
    for (let i = 0; i < 5; i++) controller.advance(closed);
    expect(controller.states[0].phase).toBe('released');
    expect(controller.targets[1]).toBe(0);
    expect(controller.targets[5]).toBe(0);
    expect(controller.targets[0]).toBe(1.5);
    expect(closed).toEqual(new Float32Array([0, 1.5, 0, 1, 0, 1.5, 0.004, 1]));
  });
});

describe('moving shoulder skin clearance', () => {
  const slopingBody: BodyMesh = { positions: new Float32Array([
    -1, 1.5, -.2, 0, 1, 1.9, -.2, 0, 1, 1.9, .2, 0, -1, 1.5, .2, 0
  ]), triangles: new Uint32Array([0, 1, 2, 0, 0, 2, 3, 0]), numTriangles: 2 };
  const support = (): AssemblySupportData => ({ revision: 2, activeOnStart: true,
    targets: new Float32Array([1.5, 1, 0, 0, 1.5, 1, 0, 0]),
    groups: [{ id: 'shoulder', kind: 'shoulder', particles: [0, 1], seamPairs: [0, 1], releaseGapM: .006, sourceZSpan: [-.3, .3] }] });
  it('raises both Y targets when either free X endpoint moves under higher actual skin', () => {
    const controller = new AssemblySupportController(support(), .1, slopingBody);
    const positions = new Float32Array([-.5, 1.5, -.3, 1, -.5, 1.5, .3, 1]);
    expect(controller.advance(positions)).toBe(true);
    expect(controller.targets[0]).toBeCloseTo(1.608, 5);
    positions[4] = .5;
    const copy = positions.slice();
    expect(controller.advance(positions)).toBe(true);
    expect(controller.targets[0]).toBeCloseTo(1.808, 5);
    expect(controller.targets[4]).toBe(controller.targets[0]);
    expect(positions).toEqual(copy);
    expect(controller.targets[1]).toBe(1);
    expect(controller.states[0].phase).toBe('assembling');
  });
  it('finds an interior skin crest missed by both endpoint samples', () => {
    const ridge: BodyMesh = { positions: new Float32Array([
      -1, 1.5, -.2, 0, 0, 2, -.2, 0, 1, 1.5, -.2, 0,
      -1, 1.5, .2, 0, 0, 2, .2, 0, 1, 1.5, .2, 0
    ]), triangles: new Uint32Array([0, 1, 4, 0, 0, 4, 3, 0, 1, 2, 5, 0, 1, 5, 4, 0]), numTriangles: 4 };
    expect(bodyUpperEnvelopeY(ridge, -.5, -.3, .3)).toBeCloseTo(1.75);
    expect(bodyUpperEnvelopeY(ridge, .5, -.3, .3)).toBeCloseTo(1.75);
    expect(bodyUpperEnvelopeSpan(ridge, -.5, .5, -.3, .3, buildBodySurfaceBVH(ridge))).toBeCloseTo(2);
  });
  it('stops following the skin during release and removes every Y hold after the fade', () => {
    const controller = new AssemblySupportController(support(), .1, slopingBody);
    const open = new Float32Array([.5, 1.5, -.3, 1, .5, 1.5, .3, 1]);
    controller.advance(open);
    const closed = new Float32Array([.5, 1.8, 0, 1, .5, 1.8, .002, 1]);
    controller.advance(closed); controller.advance(closed); controller.advance(closed);
    expect(controller.states[0].phase).toBe('releasing');
    const target = controller.targets[0];
    closed[0] = .9; closed[4] = .9;
    expect(controller.refreshTargets(closed)).toBe(false);
    expect(controller.targets[0]).toBe(target);
    for (let i = 0; i < 5; i++) controller.advance(closed);
    expect(controller.states[0].phase).toBe('released');
    expect(controller.targets[1]).toBe(0); expect(controller.targets[5]).toBe(0);
    expect(controller.refreshTargets(open)).toBe(false);
  });
  it('ignores overlapping head/ear geometry above the source anatomical neck level', () => {
    const headAndShoulder: BodyMesh = { positions: new Float32Array([
      -.2, 1.5, -.2, 0, .2, 1.5, -.2, 0, .2, 1.5, .2, 0, -.2, 1.5, .2, 0,
      -.2, 1.9, -.2, 0, .2, 1.9, -.2, 0, .2, 1.9, .2, 0, -.2, 1.9, .2, 0
    ]), triangles: new Uint32Array([0, 1, 2, 0, 0, 2, 3, 0, 4, 5, 6, 0, 4, 6, 7, 0]), numTriangles: 4 };
    const data = support(); data.groups[0].skinMaxY = 1.6;
    const controller = new AssemblySupportController(data, .1, headAndShoulder);
    controller.advance(new Float32Array([.08, 1.5, -.3, 1, .08, 1.5, .3, 1]));
    expect(bodyUpperEnvelopeSpan(headAndShoulder, .08, .08, -.3, .3)).toBeCloseTo(1.9);
    expect(controller.targets[0]).toBeCloseTo(1.508, 5);
    expect(controller.targets[4]).toBeCloseTo(1.508, 5);
  });
  it('rolls rejected closure, elapsed time and raised skin targets back to the accepted state', () => {
    const controller = new AssemblySupportController(support(), .05, slopingBody);
    const accepted = new Float32Array([-.5, 1.6, 0, 1, -.5, 1.6, .002, 1]);
    controller.advance(accepted); controller.advance(accepted);
    const snapshot = controller.captureState();
    const targetsReference = controller.targets, stateReference = controller.states[0];
    expect(snapshot.elapsedSeconds).toBeCloseTo(.1);
    const rejected = accepted.slice(); rejected[0] = .5; rejected[4] = .5;
    controller.advance(rejected);
    expect(controller.targets[0]).toBeCloseTo(1.808, 5);
    controller.advance(rejected); controller.advance(rejected);
    expect(controller.states[0].phase).toBe('releasing');
    expect(snapshot.states[0].phase).toBe('assembling');
    expect(snapshot.targets[0]).toBeCloseTo(1.608, 5);
    controller.restoreState(snapshot);
    expect(controller.targets).toBe(targetsReference);
    expect(controller.states[0]).toBe(stateReference);
    expect(controller.captureState()).toEqual(snapshot);
    controller.advance(accepted);
    expect(controller.states[0].stableFrames).toBe(3);
    // Three accepted closures still precede the minimum quarter-second hold.
    expect(controller.states[0].phase).toBe('assembling');
    expect(controller.captureState().elapsedSeconds).toBeCloseTo(.15);
    expect(snapshot.states[0].stableFrames).toBe(2);
  });
  it('restores partially faded support weights without sharing snapshot storage', () => {
    const controller = new AssemblySupportController(support(), .1, slopingBody);
    const closed = new Float32Array([-.5, 1.6, 0, 1, -.5, 1.6, .002, 1]);
    controller.advance(closed); controller.advance(closed); controller.advance(closed);
    const snapshot = controller.captureState();
    expect(snapshot.states[0].phase).toBe('releasing');
    expect(snapshot.states[0].releaseSeconds).toBeCloseTo(.1);
    for (let i = 0; i < 4; i++) controller.advance(closed);
    expect(controller.states[0].phase).toBe('released');
    expect(controller.targets[1]).toBe(0);
    controller.restoreState(snapshot);
    expect(controller.captureState()).toEqual(snapshot);
    expect(controller.targets[1]).toBeCloseTo(.8);
    controller.advance(closed);
    expect(controller.targets[1]).toBeCloseTo(.6);
    expect(snapshot.targets[1]).toBeCloseTo(.8);
    expect(snapshot.states[0].releaseSeconds).toBeCloseTo(.1);
    expect(() => controller.restoreState({ ...snapshot, states: [] })).toThrow('topology changed');
  });
  it('transfers an ongoing fade to a recreated controller with a different frame timestep', () => {
    const previous = new AssemblySupportController(support(), .1, slopingBody);
    const closed = new Float32Array([-.5, 1.6, 0, 1, -.5, 1.6, .002, 1]);
    previous.advance(closed); previous.advance(closed); previous.advance(closed);
    const snapshot = previous.captureState();
    const recreated = new AssemblySupportController(support(), .05, slopingBody);
    expect(recreated.states[0].phase).toBe('assembling');
    recreated.restoreState(snapshot);
    expect(recreated.captureState()).toEqual(snapshot);
    recreated.advance(closed);
    expect(recreated.captureState().elapsedSeconds).toBeCloseTo(.35);
    expect(recreated.states[0].releaseSeconds).toBeCloseTo(.15);
    expect(recreated.targets[1]).toBeCloseTo(.7);
    expect(previous.targets[1]).toBeCloseTo(.8);
  });
  it('keeps released supports free across recreation and rejects different same-size seam topology', () => {
    const previous = new AssemblySupportController(support(), .1, slopingBody);
    const closed = new Float32Array([-.5, 1.6, 0, 1, -.5, 1.6, .002, 1]);
    for (let i = 0; i < 7; i++) previous.advance(closed);
    const snapshot = previous.captureState();
    expect(snapshot.states[0].phase).toBe('released');
    const recreated = new AssemblySupportController(support(), .01, slopingBody);
    recreated.restoreState(snapshot);
    const moved = new Float32Array([.5, 1.8, -.3, 1, .5, 1.8, .3, 1]);
    expect(recreated.advance(moved)).toBe(false);
    expect(recreated.targets[1]).toBe(0); expect(recreated.targets[5]).toBe(0);
    expect(recreated.states[0].phase).toBe('released');
    const changed = support(); changed.groups[0].seamPairs = [1, 0];
    const incompatible = new AssemblySupportController(changed, .01, slopingBody);
    expect(() => incompatible.restoreState(snapshot)).toThrow('topology changed');
    expect(incompatible.states[0].phase).toBe('assembling');
    expect(incompatible.targets[1]).toBe(1);
  });
});

describe('staged source support release prerequisites', () => {
  const data = (): AssemblySupportData => ({ revision: 4, activeOnStart: true,
    activationSeamCount: 2, activationStitchCount: 2,
    targets: new Float32Array(16), groups: [{ id: 'shoulder', kind: 'shoulder', particles: [0, 1],
      seamPairs: [0, 1], releaseGapM: .006, releaseSeamIndices: [0, 1],
      releaseSeamPairs: [0, 1, 2, 3], releaseStitchIndices: [0, 1] }] });
  it('does not release a closed shoulder while a structural/attachment prerequisite is inactive', () => {
    const controller = new AssemblySupportController(data(), .1), positions = new Float32Array(16);
    controller.setSeamActivation(new Uint32Array([1, 0]), 2);
    for (let i = 0; i < 6; i++) controller.advance(positions);
    expect(controller.states[0].phase).toBe('assembling');expect(controller.states[0].maxSeamGapM).toBe(Infinity);
    controller.setSeamActivation(new Uint32Array([1, 1]), 1);
    for (let i = 0; i < 6; i++) controller.advance(positions);
    expect(controller.states[0].phase).toBe('assembling');expect(controller.states[0].stableFrames).toBe(0);
    controller.setSeamActivation(new Uint32Array([1, 1]), 2);positions[8] = .007;
    for (let i = 0; i < 6; i++) controller.advance(positions);
    expect(controller.states[0].phase).toBe('assembling');
    positions[8] = 0;for (let i = 0; i < 3; i++) controller.advance(positions);
    expect(controller.states[0].phase).toBe('releasing');
    for (let i = 0; i < 6; i++) controller.advance(positions);
    expect(controller.states[0].phase).toBe('released');expect(controller.targets.every((value, i) => i % 4 !== 1 || value === 0)).toBe(true);
  });
  it('clones and rolls back activation with elapsed/phase/targets; invalid activation cannot mutate it', () => {
    const controller = new AssemblySupportController(data(), .1), positions = new Float32Array(16), mask = new Uint32Array([1, 0]);
    controller.setSeamActivation(mask, 2);mask.fill(1);controller.advance(positions);
    const before = controller.captureState();expect(before.seamActivation!.activeSeams).toEqual(new Uint32Array([1, 0]));
    controller.setSeamActivation(new Uint32Array([1, 1]), 2);
    for (let i = 0; i < 4; i++) controller.advance(positions);
    controller.restoreState(before);controller.advance(positions);expect(controller.states[0].phase).toBe('assembling');
    const restored = controller.captureState();expect(restored.seamActivation).toEqual(before.seamActivation);
    expect(() => controller.setSeamActivation(new Uint32Array([1]), 2)).toThrow();expect(() => controller.setSeamActivation(new Uint32Array([1, 2]), 2)).toThrow();
    expect(controller.captureState()).toEqual(restored);
    before.seamActivation!.activeSeams.fill(1);expect(controller.captureState().seamActivation!.activeSeams).toEqual(new Uint32Array([1, 0]));
  });
  it('explicit staging disable/manual fallback retains original own-seam release instead of a whole-unit hold', () => {
    const controller = new AssemblySupportController(data(), .1), positions = new Float32Array(16);
    positions[8] = .3;
    controller.setSeamActivation(new Uint32Array([1, 0]), 0, false);
    for (let i = 0; i < 3; i++) controller.advance(positions);
    expect(controller.states[0].phase).toBe('releasing');
    expect(controller.captureState().seamActivation!.structuralEnabled).toBe(false);
    const snapshot = controller.captureState();
    controller.setSeamActivation(new Uint32Array([1, 1]), 2, true);
    controller.restoreState(snapshot);
    expect(controller.captureState().seamActivation!.structuralEnabled).toBe(false);
  });

});
