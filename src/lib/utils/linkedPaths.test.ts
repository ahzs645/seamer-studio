import { describe, it, expect } from 'vitest';
import { createEmptyPattern, type Pattern, type ConstrainablePath } from '@seamer/pattern-model';
import { canLinkPath, linkPath, unlinkPath, syncLinkedPaths, isLinkedPath } from '@seamer/pattern-model/utils/linkedPaths';

const uid = (() => { let n = 0; return (p: string) => `${p}_${++n}`; })();

/** A pattern with a curved source path (S0→S1 with one interior anchor) and a straight target. */
function base(): Pattern {
  const p = createEmptyPattern();
  p.points = [
    { id: 'S0', name: 'S0', x: 0, y: 0 },
    { id: 'SM', name: 'SM', x: 50, y: 30 },
    { id: 'S1', name: 'S1', x: 100, y: 0 },
    { id: 'T0', name: 'T0', x: 0, y: 100 },
    { id: 'T1', name: 'T1', x: 200, y: 100 }
  ];
  const mkH = (v1: { x: number; y: number }, v2: { x: number; y: number }) => ({
    v1, v2, sameLength: false, sameAngle: false,
    lengthFormula: { formula: '', unit: 'mm' }, angleFormula: { formula: '', unit: 'degrees' }
  });
  p.paths = [
    {
      id: 'src', name: 'Source', pathType: 'curve', version: 1,
      pathPoints: [
        { id: 'S0', handle: mkH({ x: 0, y: 0 }, { x: 10, y: 10 }) },
        { id: 'SM', handle: mkH({ x: -10, y: 0 }, { x: 10, y: 0 }) },
        { id: 'S1', handle: mkH({ x: -10, y: 10 }, { x: 0, y: 0 }) }
      ]
    },
    { id: 'tgt', name: 'Target', pathType: 'line', version: 1, pathPoints: [{ id: 'T0' }, { id: 'T1' }] }
  ] as ConstrainablePath[];
  return p;
}

describe('linked paths', () => {
  it('validates self and circular references', () => {
    const p = base();
    expect(canLinkPath(p, 'tgt', 'tgt').ok).toBe(false);
    expect(canLinkPath(p, 'tgt', 'src').ok).toBe(true);
    const linked = linkPath(p, 'tgt', 'src', false)!;
    // now src -> tgt would cycle
    expect(canLinkPath(linked, 'src', 'tgt').ok).toBe(false);
    expect(canLinkPath(linked, 'src', 'tgt').reason).toMatch(/circular/i);
  });

  it('maps the source shape between the target endpoints (2x scale here)', () => {
    const linked = linkPath(base(), 'tgt', 'src', false)!;
    const tgt = linked.paths.find((q) => q.id === 'tgt')!;
    expect(isLinkedPath(tgt)).toBe(true);
    expect(tgt.pathPoints).toHaveLength(3); // endpoints + 1 interior carried from the source
    const mid = linked.points.find((q) => q.id === tgt.pathPoints[1].id)!;
    // source chord (0,0)->(100,0), target chord (0,100)->(200,100): scale 2, no rotation
    expect(mid.x).toBeCloseTo(100, 6); // 50 * 2
    expect(mid.y).toBeCloseTo(160, 6); // 100 + 30 * 2
    // handles scale too
    expect(tgt.pathPoints[0].handle?.v2.x).toBeCloseTo(20, 6);
    expect(tgt.pathPoints[0].handle?.v2.y).toBeCloseTo(20, 6);
  });

  it('re-syncs when the source changes and detaches cleanly', () => {
    let p = linkPath(base(), 'tgt', 'src', false)!;
    // move the source's interior anchor
    p = { ...p, points: p.points.map((q) => (q.id === 'SM' ? { ...q, y: 60 } : q)) };
    p = syncLinkedPaths(p, uid);
    const tgt = p.paths.find((q) => q.id === 'tgt')!;
    const mid = p.points.find((q) => q.id === tgt.pathPoints[1].id)!;
    expect(mid.y).toBeCloseTo(220, 6); // 100 + 60 * 2

    const unlinked = unlinkPath(p, 'tgt');
    const t2 = unlinked.paths.find((q) => q.id === 'tgt')!;
    expect(isLinkedPath(t2)).toBe(false);
    expect(t2.pathType).toBe('curve'); // kept its synced shape
    expect(t2.pathPoints).toHaveLength(3);
  });

  it('flip mirrors the shape across the target chord', () => {
    const p = linkPath(base(), 'tgt', 'src', true)!;
    const tgt = p.paths.find((q) => q.id === 'tgt')!;
    const mid = p.points.find((q) => q.id === tgt.pathPoints[1].id)!;
    expect(mid.x).toBeCloseTo(100, 6);
    expect(mid.y).toBeCloseTo(40, 6); // reflected below the chord: 100 - 60
  });
});
