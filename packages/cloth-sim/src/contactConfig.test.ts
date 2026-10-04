import { describe, expect, it } from 'vitest';
import { createEmptyPattern, type Material, type Piece } from '@seamer/pattern-model';
import { attachGarmentCodeBody } from '@seamer/avatar';
import { SIM_CONFIG } from './config';
import { applySourceContactPolicy, inferSourceContactPolicy, resolveSourceContactConfig, sourceContactConfig } from './contactConfig';

function fixture() {
  const pattern = createEmptyPattern();
  pattern.garmentCodeSource = { format: 'garmentcode-json', unitsInMeter: 100, properties: {}, panelNames: ['front'] };
  pattern.body = attachGarmentCodeBody(pattern.body, { height: 176, head_l: 26, waist_line: 37, hips_line: 23, shoulder_w: 36, shoulder_incl: 20 });
  pattern.materials = [{ id: 'fabric', thickness: .5, visualizationThickness: 0 } as Material];
  pattern.pieces = [{ id: 'front', type: 'dynamic', materialId: 'fabric', settings3d: { enable3d: true } } as Piece];
  return pattern;
}

describe('measured source material contact envelopes', () => {
  it('uses1mm for imported0.5mm cloth while preserving unrelated solver settings and source data', () => {
    const pattern = fixture(), original = JSON.stringify(pattern), config = { ...SIM_CONFIG }, result = resolveSourceContactConfig(pattern, config);
    expect(result.config.simulationThickness).toBe(.001);
    expect(result.config.edgeThickness).toBe(.001);
    expect(result.config).toEqual({ ...config, simulationThickness: .001, edgeThickness: .001, finalContactIterations: 4, seamIterations: 8, substepContactIterations: 4 });
    expect(result.config.gravity).toBe(config.gravity);
    expect(result.contactPolicy).toMatchObject({ policy: 'source-material-thickness-v1', maximumMaterialThicknessMm: .5, automaticPaddingMeters: .001, preservedExplicitPadding: [] });
    expect(JSON.stringify(pattern)).toBe(original);
    expect(config).toEqual(SIM_CONFIG);
  });

  it('uses maximum active thickness and visual shell without unrelated library inflation', () => {
    const pattern = fixture();
    pattern.materials.push({ id: 'thick', thickness: 1.5, visualizationThickness: 2 } as Material, { id: 'unused', thickness: 100 } as Material);
    pattern.pieces.push({ ...pattern.pieces[0], id: 'back', materialId: 'thick' });
    expect(sourceContactConfig(pattern).simulationThickness).toBe(.0025);
    pattern.pieces[1].settings3d = { ...pattern.pieces[1].settings3d, enable3d: false };
    expect(sourceContactConfig(pattern).simulationThickness).toBe(.001);
    pattern.pieces[1].settings3d.enable3d = true;
    pattern.pieces[1].hidden = true;
    expect(sourceContactConfig(pattern).simulationThickness).toBe(.0025);
  });

  it('retains the0.5mm minimum for explicitly zero-thickness sheets', () => {
    const pattern = fixture(); pattern.materials[0].thickness = 0;
    expect(sourceContactConfig(pattern).simulationThickness).toBe(.0005);
    expect(sourceContactConfig(pattern).edgeThickness).toBe(.0005);
  });

  it('preserves nondefault user padding independently and records that override', () => {
    const pattern = fixture(), config = { ...SIM_CONFIG, simulationThickness: .003 };
    const result = resolveSourceContactConfig(pattern, config);
    expect(result.config.simulationThickness).toBe(.003);
    expect(result.config.edgeThickness).toBe(.001);
    expect(result.contactPolicy.preservedExplicitPadding).toEqual(['simulationThickness']);
    const lowExplicit = { ...SIM_CONFIG, simulationThickness: .0002, edgeThickness: .0003 };
    expect(sourceContactConfig(pattern, lowExplicit)).toEqual({ ...lowExplicit, finalContactIterations: 4, seamIterations: 8, substepContactIterations: 4 });
  });

  it('preserves an intentional original5mm override when explicitly marked', () => {
    const config = { ...SIM_CONFIG }, result = resolveSourceContactConfig(fixture(), config, { explicitPadding: { simulationThickness: true, edgeThickness: true } });
    expect(result.config).toEqual({ ...config, seamIterations: 8, substepContactIterations: 4 });
    expect(result.contactPolicy.preservedExplicitPadding).toEqual(['simulationThickness', 'edgeThickness']);
  });

  it('recognizes global config edits against the immutable original padding', () => {
    const previous = SIM_CONFIG.simulationThickness;
    try {
      SIM_CONFIG.simulationThickness = .008;
      expect(sourceContactConfig(fixture()).simulationThickness).toBe(.008);
    } finally { SIM_CONFIG.simulationThickness = previous; }
  });

  it('leaves native, missing-source and inactive-body configurations exactly unchanged', () => {
    const config = { ...SIM_CONFIG, gravity: [0, -3, 0] as [number, number, number], handleExternalCollisions: false };
    expect(sourceContactConfig(createEmptyPattern(), config)).toBe(config);
    const missing = fixture(); delete missing.garmentCodeSource;
    expect(sourceContactConfig(missing, config)).toBe(config);
    const inactive = fixture(); inactive.body.fields.height += 1;
    expect(sourceContactConfig(inactive, config)).toBe(config);
    const missingBody = fixture(); delete missingBody.body.garmentCodeBody;
    expect(sourceContactConfig(missingBody, config)).toBe(config);
  });

  it('fails back to existing config for invalid source metadata/body measurements', () => {
    const config = { ...SIM_CONFIG }, badUnits = fixture(); badUnits.garmentCodeSource!.unitsInMeter = NaN;
    expect(sourceContactConfig(badUnits, config)).toBe(config);
    const badMeasurements = fixture(); badMeasurements.body.garmentCodeBody!.measurementsCm.height = -1;
    expect(sourceContactConfig(badMeasurements, config)).toBe(config);
  });

  it.each([NaN, Infinity, -1, undefined, null, '0.5'])('does not guess malformed physical thickness%j', thickness => {
    const pattern = fixture(), config = { ...SIM_CONFIG };
    pattern.materials[0].thickness = thickness as number;
    const result = resolveSourceContactConfig(pattern, config);
    expect(result.config).toBe(config); expect(result.contactPolicy.reason).toBe('invalid-thickness');
  });

  it('preserves original padding for missing material or malformed visual thickness', () => {
    const pattern = fixture(), config = { ...SIM_CONFIG };
    pattern.materials[0].visualizationThickness = NaN;
    expect(sourceContactConfig(pattern, config)).toBe(config);
    pattern.materials = [];
    expect(sourceContactConfig(pattern, config)).toBe(config);
    const noCloth = fixture(); noCloth.pieces[0].type = 'annotation';
    expect(resolveSourceContactConfig(noCloth, config)).toMatchObject({ config, contactPolicy: { reason: 'no-active-cloth' } });
  });

  it('applies prepared material policy to current options instead of stale preparation settings', () => {
    const target = inferSourceContactPolicy(fixture());
    const current = { ...SIM_CONFIG, gravity: [0, -2, 0] as [number, number, number], timeStep: .02, subSteps: 20, deltaT: .001,
      maxVelocity: .75, handleExternalCollisions: false, handleSelfSurfaceCollisions: false };
    const resolved = applySourceContactPolicy(current, target);
    expect(resolved.config).toEqual({ ...current, simulationThickness: .001, edgeThickness: .001, finalContactIterations: 4, seamIterations: 8, substepContactIterations: 4 });
    expect(applySourceContactPolicy({ ...current, edgeThickness: .007 }, target).config.edgeThickness).toBe(.007);
    expect(target.preservedExplicitPadding).toEqual([]);
    const malformed = { ...target, automaticPaddingMeters: NaN };
    expect(applySourceContactPolicy(current, malformed).config).toBe(current);
  });

  it('adds four thin-source finishing passes while keeping recovery independent and native unchanged', () => {
    const pattern = fixture(), result = resolveSourceContactConfig(pattern, { ...SIM_CONFIG, maxSurfaceCorrection: .007 });
    expect(result.config.finalContactIterations).toBe(4);
    expect(result.config.maxSurfaceCorrection).toBe(.007);
    expect(result.contactPolicy).toMatchObject({ automaticFinalContactIterations: 4, preservedExplicitFinalContactIterations: false });
    expect(sourceContactConfig(createEmptyPattern(), SIM_CONFIG)).toBe(SIM_CONFIG);
    expect(SIM_CONFIG.finalContactIterations).toBe(1);
    pattern.materials[0].thickness = 4.5;
    const thick = resolveSourceContactConfig(pattern, SIM_CONFIG);
    expect(thick.config).toEqual({ ...SIM_CONFIG, seamIterations: 8, substepContactIterations: 4 });
    expect(thick.contactPolicy.automaticFinalContactIterations).toBe(1);
  });

  it('preserves explicit finishing counts, including a deliberately selected single pass', () => {
    const config = { ...SIM_CONFIG, finalContactIterations: 7 }, result = resolveSourceContactConfig(fixture(), config);
    expect(result.config.finalContactIterations).toBe(7);
    expect(result.contactPolicy.preservedExplicitFinalContactIterations).toBe(true);
    const single = resolveSourceContactConfig(fixture(), SIM_CONFIG, { explicitFinalContactIterations: true });
    expect(single.config.finalContactIterations).toBe(1);
    expect(single.contactPolicy.preservedExplicitFinalContactIterations).toBe(true);
    const missing = { ...SIM_CONFIG }; delete missing.finalContactIterations;
    expect(sourceContactConfig(fixture(), missing).finalContactIterations).toBe(4);
  });

  it('chooses finishing policy from actual current clearance rather than a stale inferred thin target', () => {
    const inferred = inferSourceContactPolicy(fixture());
    expect(inferred.automaticFinalContactIterations).toBe(4);
    const resolved = applySourceContactPolicy({ ...SIM_CONFIG, simulationThickness: .008 }, inferred);
    expect(resolved.config.finalContactIterations).toBe(1);
    expect(resolved.contactPolicy.automaticFinalContactIterations).toBe(1);
  });

  it('uses eight source sewing iterations independently of material thickness and native defaults', () => {
    const pattern = fixture(), thin = resolveSourceContactConfig(pattern, SIM_CONFIG);
    expect(thin.config.seamIterations).toBe(8);
    expect(thin.contactPolicy).toMatchObject({ automaticSeamIterations: 8, preservedExplicitSeamIterations: false });
    pattern.materials[0].thickness = 8;
    const thick = resolveSourceContactConfig(pattern, SIM_CONFIG);
    expect(thick.config.simulationThickness).toBe(.0085);
    expect(thick.config.finalContactIterations).toBe(1);
    expect(thick.config.seamIterations).toBe(8);
    expect(sourceContactConfig(createEmptyPattern(), SIM_CONFIG)).toBe(SIM_CONFIG);
    expect(SIM_CONFIG.seamIterations).toBe(1);
  });

  it('preserves current explicit source sewing counts and a deliberate single iteration', () => {
    const inferred = inferSourceContactPolicy(fixture());
    const current = { ...SIM_CONFIG, seamIterations: 3, maxVelocity: .75, timeStep: .02 };
    const resolved = applySourceContactPolicy(current, inferred);
    expect(resolved.config.seamIterations).toBe(3);
    expect(resolved.config.maxVelocity).toBe(.75);
    expect(resolved.config.timeStep).toBe(.02);
    expect(resolved.contactPolicy.preservedExplicitSeamIterations).toBe(true);
    const explicit = applySourceContactPolicy(SIM_CONFIG, inferred, { explicitSeamIterations: true });
    expect(explicit.config.seamIterations).toBe(1);
    expect(explicit.contactPolicy.preservedExplicitSeamIterations).toBe(true);
    expect(inferred).toMatchObject({ automaticSeamIterations: 8, preservedExplicitSeamIterations: false });
  });

  it('keeps disabled collision flags, timestep and other supplied options unchanged', () => {
    const config = { ...SIM_CONFIG, handleSelfCollisions: false, handleSelfSurfaceCollisions: false, handleExternalCollisions: false,
      handleExternalSurfaceCollisions: false, timeStep: .01, subSteps: 80, deltaT: .000125, maxVelocity: .5 };
    expect(sourceContactConfig(fixture(), config)).toEqual({ ...config, simulationThickness: .001, edgeThickness: .001, finalContactIterations: 4, seamIterations: 8, substepContactIterations: 4 });
  });
});


describe('source every-substep contact convergence', () => {
  it('adds source collision-only convergence passes without changing native timing or recovery bounds', () => {
    const result = resolveSourceContactConfig(fixture(), SIM_CONFIG);
    expect(result.config.substepContactIterations).toBe(4);
    expect(result.config.finalContactIterations).toBe(4);
    expect(result.config.maxSurfaceCorrection).toBe(.005);
    expect(result.config.timeStep).toBe(SIM_CONFIG.timeStep);
    expect(result.config.subSteps).toBe(SIM_CONFIG.subSteps);
    expect(result.contactPolicy.automaticSubstepContactIterations).toBe(4);
    expect(result.contactPolicy.preservedExplicitSubstepContactIterations).toBe(false);
    const native = fixture(); delete native.garmentCodeSource;
    expect(resolveSourceContactConfig(native, SIM_CONFIG).config).toBe(SIM_CONFIG);
    expect(SIM_CONFIG.substepContactIterations).toBe(1);
  });
  it('honors explicit single-pass and nondefault iteration settings', () => {
    const custom = resolveSourceContactConfig(fixture(), { ...SIM_CONFIG, substepContactIterations: 5 });
    expect(custom.config.substepContactIterations).toBe(5);
    expect(custom.contactPolicy.preservedExplicitSubstepContactIterations).toBe(true);
    const single = resolveSourceContactConfig(fixture(), SIM_CONFIG, { explicitSubstepContactIterations: true });
    expect(single.config.substepContactIterations).toBe(1);
    expect(single.contactPolicy.preservedExplicitSubstepContactIterations).toBe(true);
  });
});
