import { describe, it, expect } from 'vitest';
import { parseRul, applyRulToPattern, cumulativeRuleOffset, importRulFile } from './rulImport';
import { createEmptyPattern } from '@seamer/pattern-model';

const FIXTURE = `
* Gerber AccuMark export
GRADE RULE TABLE: MISSES BODICE
NUMERIC
UNITS: INCHES
SIZE LIST: 8 10 12 14 16
SAMPLE SIZE: 12

RULE 1
 0.000  0.000
 0.000  0.000
 0.000  0.000
 0.000  0.000

RULE 2
 -0.125  0.250
 -0.125  0.250
 -0.250  0.500
 -0.250  0.500
`;

describe('parseRul', () => {
  it('parses the header', () => {
    const t = parseRul(FIXTURE);
    expect(t.name).toBe('MISSES BODICE');
    expect(t.isNumeric).toBe(true);
    expect(t.units).toBe('inch');
  });

  it('parses the size list and sample size', () => {
    const t = parseRul(FIXTURE);
    expect(t.sizes).toEqual(['8', '10', '12', '14', '16']);
    expect(t.sampleSize).toBe('12');
  });

  it('parses rules into per-break offsets converted to mm', () => {
    const t = parseRul(FIXTURE);
    expect(t.rules.size).toBe(2);
    expect(t.rules.get(1)).toHaveLength(4);
    const r2 = t.rules.get(2)!;
    expect(r2).toHaveLength(4);
    expect(r2[0].dx).toBeCloseTo(-0.125 * 25.4);
    expect(r2[0].dy).toBeCloseTo(0.25 * 25.4);
    expect(r2[2].dx).toBeCloseTo(-0.25 * 25.4);
  });

  it('parses alphanumeric sizing and defaults the sample size to the first size', () => {
    const t = parseRul('GRADE RULE TABLE: T\nALPHANUMERIC\nSIZE LIST: S, M, L\nRULE 1\n0 0\n0 0\n');
    expect(t.isNumeric).toBe(false);
    expect(t.sizes).toEqual(['S', 'M', 'L']);
    expect(t.sampleSize).toBe('S');
  });

  it('throws on garbage input', () => {
    expect(() => parseRul('not a rul file at all')).toThrow(/GRADE RULE TABLE/);
    expect(() => parseRul('')).toThrow(/Empty/);
  });

  it('throws on a malformed offset line and a missing size list', () => {
    expect(() => parseRul('GRADE RULE TABLE: T\nSIZE LIST: 8 10\nRULE 1\n0.1 abc\n')).toThrow(/malformed offset/);
    expect(() => parseRul('GRADE RULE TABLE: T\nSAMPLE SIZE: 8\n')).toThrow(/SIZE LIST/);
  });

  it('throws when the sample size is not in the size list', () => {
    expect(() => parseRul('GRADE RULE TABLE: T\nSIZE LIST: 8 10\nSAMPLE SIZE: 99\n')).toThrow(/sample size/i);
  });
});

describe('cumulativeRuleOffset', () => {
  it('sums breaks up from the sample size and negates going down', () => {
    const t = parseRul(FIXTURE);
    // sample 12 -> 16 crosses breaks 2 and 3 of rule 2
    const up = cumulativeRuleOffset(t, 2, '16');
    expect(up.dx).toBeCloseTo(-0.5 * 25.4);
    expect(up.dy).toBeCloseTo(1.0 * 25.4);
    // sample 12 -> 8 crosses breaks 0 and 1, negated
    const down = cumulativeRuleOffset(t, 2, '8');
    expect(down.dx).toBeCloseTo(0.25 * 25.4);
    expect(down.dy).toBeCloseTo(-0.5 * 25.4);
    expect(cumulativeRuleOffset(t, 2, '12')).toEqual({ dx: 0, dy: 0 });
  });
});

describe('applyRulToPattern', () => {
  it('populates gradingProfile.sizes and sets the current size', () => {
    const t = parseRul(FIXTURE);
    const p = applyRulToPattern(createEmptyPattern(), t);
    expect(p.currentSize).toBe('12');
    expect(p.gradingProfile?.sizes.map((s) => s.name)).toEqual(['8', '10', '14', '16']);
    expect(p.gradingProfile?.sizes.every((s) => s.scale === 1 && s.color && s.id)).toBe(true);
    expect(p.hasChanged).toBe(true);
  });

  it('honours a chosen size and rejects unknown sizes', () => {
    const t = parseRul(FIXTURE);
    const p = applyRulToPattern(createEmptyPattern(), t, { chosenSize: '16' });
    expect(p.currentSize).toBe('16');
    expect(p.gradingProfile?.sizes.map((s) => s.name)).toEqual(['8', '10', '12', '14']);
    expect(() => applyRulToPattern(createEmptyPattern(), t, { chosenSize: 'XL' })).toThrow(/chosen size/);
  });
});

describe('importRulFile', () => {
  it('parses and applies in one call', () => {
    const { pattern, table } = importRulFile(FIXTURE, createEmptyPattern(), '10');
    expect(table.name).toBe('MISSES BODICE');
    expect(pattern.currentSize).toBe('10');
    expect(pattern.gradingProfile?.sizes).toHaveLength(4);
  });
});
