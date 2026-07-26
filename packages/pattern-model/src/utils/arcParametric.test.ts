import { describe, it, expect } from 'vitest';
import { createDoc, Editor } from '@atelier/core';
import { createEmptyPattern, type Pattern } from '../pattern';
import { createPatternRegistry } from '../commands/registry';
import { rebakeArc, detachArcsTouchingAnchor, arcPathsCenteredOn } from './arcParametric';

const uid = (() => { let n = 0; return (p: string) => `${p}_${++n}`; })();

function host(initial: Pattern): { h: Editor<Pattern>; get: () => Pattern } {
  const instance = new Editor(createDoc(initial), { registry: createPatternRegistry() });
  return {
    h: instance,
    get: () => instance.content
  };
}

const executeCommand = (
  instance: Editor<Pattern>,
  type: string,
  params: Record<string, unknown>
) => instance.execute(type, params);

describe('parametric arcs', () => {
  it('rebakeArc changes the radius in place, preserving anchor point ids', () => {
    const { h, get } = host(createEmptyPattern());
    executeCommand(h, 'path.createCenterArc', { center: { x: 0, y: 0 }, start: { x: 40, y: 0 }, end: { x: 0, y: 40 } });
    const before = get().paths[0];
    const idsBefore = before.pathPoints.map((pp) => pp.id);
    const next = rebakeArc(get(), before.id, { ...before.arc!, r: 80 }, uid)!;
    expect(next).not.toBeNull();
    const after = next.paths[0];
    expect(after.pathPoints.map((pp) => pp.id)).toEqual(idsBefore); // same segment count -> same ids
    for (const pp of after.pathPoints) {
      const pt = next.points.find((q) => q.id === pp.id)!;
      expect(Math.hypot(pt.x, pt.y)).toBeCloseTo(80, 4);
    }
    expect(after.arc?.r).toBe(80);
  });

  it('rebakeArc grows/shrinks the anchor list when the sweep changes segment count', () => {
    const { h, get } = host(createEmptyPattern());
    executeCommand(h, 'path.createCenterArc', { center: { x: 0, y: 0 }, start: { x: 40, y: 0 }, end: { x: 0, y: 40 } }); // 90° -> 2 anchors
    const path = get().paths[0];
    const endId = path.pathPoints[path.pathPoints.length - 1].id;
    const next = rebakeArc(get(), path.id, { ...path.arc!, a1: path.arc!.a0 + Math.PI * 1.5 }, uid)!; // 270° -> 4 anchors
    const after = next.paths[0];
    expect(after.pathPoints.length).toBe(4);
    expect(after.pathPoints[0].id).toBe(path.pathPoints[0].id); // endpoints preserved
    expect(after.pathPoints[after.pathPoints.length - 1].id).toBe(endId);
    for (const pp of after.pathPoints) {
      const pt = next.points.find((q) => q.id === pp.id)!;
      expect(Math.hypot(pt.x, pt.y)).toBeCloseTo(40, 4);
    }
  });

  it('a circle follows its centre point and detaches when an anchor is hand-edited', () => {
    const { h, get } = host(createEmptyPattern());
    executeCommand(h, 'path.createEllipse', { center: { x: 0, y: 0 }, radiusPoint: { x: 30, y: 0 } });
    const path = get().paths[0];
    const centerId = path.arc!.centerId!;
    expect(arcPathsCenteredOn(get(), centerId).map((q) => q.id)).toEqual([path.id]);
    // move the centre, rebake -> all anchors orbit the new centre
    const moved: Pattern = {
      ...get(),
      points: get().points.map((q) => (q.id === centerId ? { ...q, x: 100, y: 50 } : q))
    };
    const next = rebakeArc(moved, path.id, path.arc!, uid)!;
    for (const pp of next.paths[0].pathPoints) {
      const pt = next.points.find((q) => q.id === pp.id)!;
      expect(Math.hypot(pt.x - 100, pt.y - 50)).toBeCloseTo(30, 4);
    }
    // dragging an anchor detaches the metadata
    const anchorId = path.pathPoints[0].id;
    const detached = detachArcsTouchingAnchor(next, anchorId);
    expect(detached.paths[0].arc).toBeUndefined();
    // but moving the centre does not detach
    expect(detachArcsTouchingAnchor(next, centerId).paths[0].arc).toBeDefined();
  });
});
