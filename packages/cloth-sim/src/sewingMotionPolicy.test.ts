import { describe, expect, it } from 'vitest';
import { type SimConfig, SIM_CONFIG, resolveSewingMotionPolicy, seamMaxDisplacementSq } from './config';
import { seamWGSL } from './webgpu/shaders';

function sourcePolicy(cfg: SimConfig) {
  const policy = resolveSewingMotionPolicy(cfg, true);
  if (policy.policy !== 'source-open-budget-closed-restoration-v2') throw new Error('Expected source policy');
  return policy;
}

describe('open source sewing shares the budget while closed joins retain restoration', () => {
  it.each([1, 2, 8, 16, 64])('preserves the original total budget for %s source iterations', iterations => {
    const cfg = { ...SIM_CONFIG, maxVelocity: 1, deltaT: .0004, seamIterations: iterations };
    const source = sourcePolicy(cfg);
    expect(source.policy).toBe('source-open-budget-closed-restoration-v2');
    expect(source.actualIterations).toBe(iterations);
    expect(source.openSubstepTravelUpperBoundMeters).toBe(.0008);
    expect(source.openPerIterationMaximumSq).toBe(seamMaxDisplacementSq(cfg) / (iterations * iterations));
    expect(source.openSubstepTravelUpperBoundMeters).toBeCloseTo(.0008, 14);
    // Constant forcing saturates every Jacobi clamp in the same direction. Extra
    // convergence iterations must not multiply this worst-case material travel.
    const total = Array.from({ length: iterations }, () => source.openPerIterationMaximumMeters).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(.0008, 14);
    expect(seamWGSL(cfg, source.openPerIterationMaximumSq)).toContain(String(source.openPerIterationMaximumSq));
  });
  it.each([1, 8])('keeps native %s-iteration shader clamp bit-identical', iterations => {
    const cfg = { ...SIM_CONFIG, seamIterations: iterations };
    const native = resolveSewingMotionPolicy(cfg, false);
    expect(native.policy).toBe('legacy-per-iteration-v1');
    if (native.policy !== 'legacy-per-iteration-v1') throw new Error('Expected native policy');
    expect(Object.is(native.perIterationMaximumSq, seamMaxDisplacementSq(cfg))).toBe(true);
    expect(seamWGSL(cfg, native.perIterationMaximumSq)).toBe(seamWGSL(cfg, seamMaxDisplacementSq(cfg)));
  });
  it('uses the actual ceil dispatch count for an explicit fractional iteration value', () => {
    const cfg = { ...SIM_CONFIG, seamIterations: 7.25 };
    const policy = sourcePolicy(cfg);
    let actualDispatches = 0;
    for (let index = 0; index < Math.max(1, cfg.seamIterations); index++) actualDispatches++;
    expect(policy.actualIterations).toBe(actualDispatches);
    expect(actualDispatches).toBe(8);
    expect(policy.openPerIterationMaximumSq).toBe(seamMaxDisplacementSq(cfg) / 64);
  });
  it('preserves source explicit one iteration and the existing minimum iteration', () => {
    for (const seamIterations of [1, 0, -2]) {
      const cfg = { ...SIM_CONFIG, seamIterations };
      expect(sourcePolicy(cfg).openPerIterationMaximumSq).toBe(seamMaxDisplacementSq(cfg));
      expect(sourcePolicy(cfg).closedRestorationPerIterationMaximumSq).toBe(seamMaxDisplacementSq(cfg));
    }
  });
  it('freezes actual policy evidence against caller config mutations', () => {
    const cfg = { ...SIM_CONFIG, seamIterations: 8 }, policy = sourcePolicy(cfg);
    cfg.seamIterations = 1; cfg.deltaT = 1;
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.actualIterations).toBe(8);
    expect(policy.openPerIterationMaximumSq).not.toBe(seamMaxDisplacementSq(cfg));
  });
  it('reports the larger closed-join restoration bound without claiming a shared universal budget', () => {
    const cfg = { ...SIM_CONFIG, maxVelocity: 1, deltaT: .0004, seamIterations: 8 };
    const policy = sourcePolicy(cfg);
    expect(policy.closedGapCriterionMeters).toBe(.003);
    expect(policy.closedRestorationPerIterationMaximumSq).toBe(seamMaxDisplacementSq(cfg));
    expect(policy.closedRestorationPerIterationMaximumMeters).toBe(.0008);
    expect(policy.closedRestorationSubstepTravelUpperBoundMeters).toBe(.0064);
    expect(policy.universalSharedSubstepBudget).toBe(false);
  });
  it('classifies enabled source links from immutable prior-substep geometry after both gates', () => {
    const cfg = { ...SIM_CONFIG, seamIterations: 8 }, policy = sourcePolicy(cfg);
    const code = seamWGSL(cfg, policy.openPerIterationMaximumSq, undefined, {
      maximumSq: policy.closedRestorationPerIterationMaximumSq,
      previousGapSq: policy.closedGapCriterionMeters ** 2
    });
    expect(code).toContain('@binding(5) var<storage, read> lastPositions');
    const classification = code.indexOf('let previousGap = lastPositions[ci].xyz - lastPositions[index].xyz');
    expect(classification).toBeGreaterThan(code.indexOf('>= gate.sewnUpTo'));
    expect(classification).toBeGreaterThan(code.indexOf('!activeSourceStitch'));
    expect(code).toContain('dot(previousGap, previousGap) <= closedGapSq');
    expect(code).not.toContain('lastPositions[index] =');
    expect(seamWGSL(cfg, seamMaxDisplacementSq(cfg))).not.toContain('lastPositions');
  });
  it.each([NaN, Infinity, 64.1])('rejects an unbounded source dispatch count %s before GPU allocation', iterations => {
    expect(() => resolveSewingMotionPolicy({ ...SIM_CONFIG, seamIterations: iterations }, true)).toThrow('finite substep');
  });
  it('rejects invalid source physical units and accepts an intentional zero velocity', () => {
    for (const values of [{ deltaT: 0 }, { deltaT: NaN }, { maxVelocity: -1 }, { maxVelocity: Infinity }])
      expect(() => resolveSewingMotionPolicy({ ...SIM_CONFIG, ...values }, true)).toThrow('finite substep');
    expect(sourcePolicy({ ...SIM_CONFIG, maxVelocity: 0 }).openPerIterationMaximumSq).toBe(0);
    expect(() => resolveSewingMotionPolicy({ ...SIM_CONFIG, maxVelocity: 1e200, deltaT: 1e200 }, true)).toThrow('finite squared');
    expect(() => resolveSewingMotionPolicy({ ...SIM_CONFIG, maxVelocity: 1e160, deltaT: 1 }, true)).toThrow('finite squared');
  });
});
