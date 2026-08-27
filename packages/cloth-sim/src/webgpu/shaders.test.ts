// CPU checks on the collision and bending kernels in shaders.ts.
//
// These kernels are WGSL held in template strings, so nothing in the toolchain reads them:
// `tsc` sees a string, eslint ignores the file outright, and `scripts/check-wgsl.mjs` only proves
// the text compiles and builds a pipeline — a sign error compiles perfectly. The unit tests never
// touch a GPU, so the only way to pin the *arithmetic* is to run it here.
//
// Both suites below drive the shipped shader text rather than a hand-copy wherever they can:
// `getClosestPointOnTriangle` is extracted from the shader source and compiled to a callable, and
// the bending kernel's rotation signs and tuning constants are parsed out of its source. Each
// suite also includes a mutation check that deliberately reintroduces the old behaviour and
// asserts the expectations fail for it — without that, a test that passed either way would prove
// nothing.
//
// Three defects are pinned here, all of which compiled and shipped:
//   * `getClosestPointOnTriangle` fed Eberly's region walk `point - p0`, the negation of the
//     difference vector it is derived for, so a query over the middle of a face returned a vertex.
//   * The same function's region 6 fallback minimised along edge1 (`-e/c`) on the edge0 collapse,
//     returning p0 for queries whose closest point is p1.
//   * The bending kernel rotated the hinge the way that grows the dihedral error, so a fold came
//     to rest at `target - 180deg` (clampAngle's wrap is a fixed point) rather than at `target`.

import { describe, it, expect } from 'vitest';
import { solveExternalCollisionWGSL, solveSelfCollisionWGSL, bendingConstraintWGSL } from './shaders';
import { SIM_CONFIG } from '../config';

type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const add3 = (a: Vec3, b: Vec3, c: Vec3): Vec3 => add(add(a, b), c);
const scale = (s: number, v: Vec3): Vec3 => [s * v[0], s * v[1], s * v[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const normalize = (v: Vec3): Vec3 => scale(1 / length(v), v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Pull one `fn <name>(...) { ... }` out of a WGSL source by matching braces. */
function extractFn(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  expect(start, `shader has no fn ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated fn ${name}`);
}

// -------------------------------------------------------------------------------------------
// 1. getClosestPointOnTriangle

/**
 * Compile the shipped `getClosestPointOnTriangle` WGSL into a callable.
 *
 * Everything between the vector lines is already valid JavaScript — WGSL and JS agree on
 * `let`/`var`, `if`/`else`, `0.0` literals and the scalar operators — so the only rewriting
 * needed is vec3 arithmetic, which JS has no operators for. A one-pass type environment tracks
 * which locals hold a vec3 (the four parameters, plus anything derived from them) so that
 * `let edge0 = p1 - p0;` is rewritten while the scalar `let numer = tmp1 - tmp0;` is left alone.
 *
 * Every rewrite is counted and asserted. If the shader is reshaped so a rule stops matching, this
 * throws instead of quietly testing something else.
 */
function compileClosestPoint(wgsl: string): (p0: Vec3, p1: Vec3, p2: Vec3, point: Vec3) => Vec3 {
  const open = wgsl.indexOf('{');
  const body = wgsl.slice(open + 1, wgsl.lastIndexOf('}'));
  const vec3s = new Set(['p0', 'p1', 'p2', 'point']);
  let differences = 0;
  let returns = 0;

  const translated = body
    // `let edge0 = p1 - p0;` -> `let edge0 = sub(p1, p0);`, only when both sides are vec3.
    .replace(/\b(let|var)\s+(\w+)\s*=\s*(\w+)\s*-\s*(\w+)\s*;/g, (whole, kw, name, a, b) => {
      if (!vec3s.has(a) || !vec3s.has(b)) return whole;
      vec3s.add(name);
      differences++;
      return `${kw} ${name} = sub(${a}, ${b});`;
    })
    // `return p0 + s * edge0 + t * edge1;`
    .replace(
      /\breturn\s+(\w+)\s*\+\s*(\w+)\s*\*\s*(\w+)\s*\+\s*(\w+)\s*\*\s*(\w+)\s*;/g,
      (whole, base, s, e0, t, e1) => {
        if (!vec3s.has(base) || !vec3s.has(e0) || !vec3s.has(e1)) return whole;
        returns++;
        return `return add3(${base}, scale(${s}, ${e0}), scale(${t}, ${e1}));`;
      }
    );

  expect(differences, 'expected the edge0/edge1/v0 difference line').toBe(3);
  expect(returns, 'expected the barycentric return line').toBe(1);

  const factory = new Function(
    'sub',
    'add3',
    'scale',
    'dot',
    'clamp',
    `return function (p0, p1, p2, point) {\n${translated}\n};`
  ) as unknown as (
    sub_: typeof sub,
    add3_: typeof add3,
    scale_: typeof scale,
    dot_: typeof dot,
    clamp_: typeof clamp
  ) => (p0: Vec3, p1: Vec3, p2: Vec3, point: Vec3) => Vec3;

  return factory(sub, add3, scale, dot, clamp);
}

describe('getClosestPointOnTriangle (WGSL, run on the CPU)', () => {
  const externalSrc = extractFn(
    solveExternalCollisionWGSL(SIM_CONFIG, 8),
    'getClosestPointOnTriangle'
  );
  const selfSrc = extractFn(solveSelfCollisionWGSL(SIM_CONFIG), 'getClosestPointOnTriangle');

  it('is byte-identical in the external- and self-collision kernels', () => {
    // The function is copied into both shaders. Fixing one and not the other is worse than
    // fixing neither, because the two solvers would then disagree about the same contact.
    expect(selfSrc).toBe(externalSrc);
  });

  // A right triangle in the y = 0 plane. edge0 runs along +x, edge1 along +z, so the seven
  // Voronoi regions of Eberly's walk map onto easily-read coordinates. Queries sit off the plane
  // because that is what a real contact looks like; the perpendicular offset does not move the
  // closest point.
  const p0: Vec3 = [0, 0, 0];
  const p1: Vec3 = [10, 0, 0];
  const p2: Vec3 = [0, 0, 10];

  const cases: Array<{ region: string; query: Vec3; expected: Vec3 }> = [
    // Interior — the case a panel landing flat on another panel is made of, and the one the
    // negated difference vector got wrong (it returned p0).
    { region: 'interior (face)', query: [3.33, 1, 3.33], expected: [3.33, 0, 3.33] },
    { region: 'interior (near p1 corner)', query: [7, -2, 1], expected: [7, 0, 1] },
    // Edges.
    { region: 'edge p0-p1 (t = 0)', query: [4, 1, -5], expected: [4, 0, 0] },
    { region: 'edge p0-p2 (s = 0)', query: [-5, 1, 4], expected: [0, 0, 4] },
    { region: 'edge p1-p2 (s + t = 1)', query: [8, 1, 8], expected: [5, 0, 5] },
    // Vertices.
    { region: 'vertex p0', query: [-5, 1, -5], expected: [0, 0, 0] },
    { region: 'vertex p1', query: [15, 1, -5], expected: [10, 0, 0] },
    { region: 'vertex p2', query: [-5, 1, 15], expected: [0, 0, 10] }
  ];

  for (const kernel of ['external', 'self'] as const) {
    const closest = compileClosestPoint(kernel === 'external' ? externalSrc : selfSrc);
    for (const { region, query, expected } of cases) {
      it(`${kernel} kernel: ${region}`, () => {
        const got = closest(p0, p1, p2, query);
        expect(got[0]).toBeCloseTo(expected[0], 6);
        expect(got[1]).toBeCloseTo(expected[1], 6);
        expect(got[2]).toBeCloseTo(expected[2], 6);
      });
    }
  }

  it('agrees with an independent closest-point reference on random triangles', () => {
    // The region walk is a case analysis, and the named cases above only reach a region if the
    // expectation was written for it -- which is exactly how the region 6 fallback stayed wrong.
    // This compares it against a reference derived a different way (project onto the plane if the
    // projection is inside, otherwise take the nearest of the three clamped edge projections), so
    // no region can be missed by omission.
    const closest = compileClosestPoint(externalSrc);
    let seed = 0x2f6e2b1;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const coordinate = (spread: number): number => (random() * 2 - 1) * spread;

    const onSegment = (a: Vec3, b: Vec3, q: Vec3): Vec3 => {
      const ab = sub(b, a);
      return add(a, scale(clamp(dot(sub(q, a), ab) / dot(ab, ab), 0, 1), ab));
    };
    const reference = (a: Vec3, b: Vec3, c: Vec3, q: Vec3): Vec3 => {
      const candidates = [onSegment(a, b, q), onSegment(b, c, q), onSegment(c, a, q)];
      const n = normalize(cross(sub(b, a), sub(c, a)));
      const projected = sub(q, scale(dot(sub(q, a), n), n));
      // Barycentric test for the projection, via triangle areas along the face normal.
      const area = (u: Vec3, v: Vec3, w: Vec3): number => dot(cross(sub(v, u), sub(w, u)), n);
      const total = area(a, b, c);
      const [u, v, w] = [
        area(projected, b, c) / total,
        area(a, projected, c) / total,
        area(a, b, projected) / total
      ];
      if (u >= 0 && v >= 0 && w >= 0) candidates.push(projected);
      return candidates.reduce((best, p) =>
        length(sub(p, q)) < length(sub(best, q)) ? p : best
      );
    };

    let checked = 0;
    for (let trial = 0; trial < 300; trial++) {
      const a: Vec3 = [coordinate(10), coordinate(10), coordinate(10)];
      const b: Vec3 = [coordinate(10), coordinate(10), coordinate(10)];
      const c: Vec3 = [coordinate(10), coordinate(10), coordinate(10)];
      if (length(cross(sub(b, a), sub(c, a))) < 5) continue; // skip slivers
      for (let k = 0; k < 12; k++) {
        const q: Vec3 = [coordinate(16), coordinate(16), coordinate(16)];
        const got = closest(a, b, c, q);
        const want = reference(a, b, c, q);
        // Compare distances, not points: on a tie the two may pick different equally-close points.
        expect(length(sub(got, q))).toBeCloseTo(length(sub(want, q)), 6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('would fail if the difference vector were negated again', () => {
    // Eberly derives the region walk for v0 = p0 - point. Feeding it point - p0 negates d and e,
    // hence s and t, so an interior query lands in the s<0,t<0 corner and returns a vertex. This
    // asserts the suite above can actually tell the two apart.
    const negated = externalSrc.replace('let v0 = p0 - point;', 'let v0 = point - p0;');
    expect(negated, 'the v0 line moved; update this mutation').not.toBe(externalSrc);
    const broken = compileClosestPoint(negated)(p0, p1, p2, [3.33, 1, 3.33]);
    expect(broken).toEqual([0, 0, 0]); // p0, not the face point
  });

  it('would fail if region 6 fell back to the wrong edge again', () => {
    // Region 6 (t < 0 past the s + t = 1 line) collapses onto the t = 0 edge, so the remaining
    // parameter minimises along edge0: s = -d/a. Using -e/c there is edge1's minimiser, which
    // clamps to 0 for a query beyond p1 and returns p0 -- the far vertex of the wrong edge.
    const swapped = externalSrc.replace(
      'else { s = clamp(-d / a, 0.0, 1.0); t = 0.0; }',
      'else { s = clamp(-e / c, 0.0, 1.0); t = 0.0; }'
    );
    expect(swapped, 'the region 6 fallback moved; update this mutation').not.toBe(externalSrc);
    const broken = compileClosestPoint(swapped)(p0, p1, p2, [15, 1, -5]);
    expect(broken).toEqual([0, 0, 0]); // p0, when p1 is the closest point
  });
});

// -------------------------------------------------------------------------------------------
// 2. bendingConstraintWGSL's angular fold path

const bendingSrc = bendingConstraintWGSL(SIM_CONFIG);

/** Read a `const NAME = <number>...;` out of the shader so the CPU loop uses the shipped tuning. */
function shaderConst(name: string): number {
  const match = bendingSrc.match(new RegExp(`const ${name}\\s*[:=][^=]*=?\\s*(-?[\\d.]+(?:e-?\\d+)?)`));
  expect(match, `shader has no const ${name}`).not.toBeNull();
  return Number(match![1]);
}

/**
 * The signs the shader applies to the two opposite vertices. These are the whole defect, so they
 * are read from the shipped text rather than restated here: flipping them in shaders.ts flips what
 * this suite simulates, and the convergence assertions below stop holding.
 */
function nudgeSigns(source: string): { s1: number; s2: number } {
  const m1 = source.match(
    /p1 = hingeMid \+ rotateAroundAxis\(p1 - hingeMid, edgeDir,\s*(-?)\s*angleStep \* w1Scale\);/
  );
  const m2 = source.match(
    /p2 = hingeMid \+ rotateAroundAxis\(p2 - hingeMid, edgeDir,\s*(-?)\s*angleStep \* w2Scale\);/
  );
  expect(m1, 'shader has no p1 hinge rotation').not.toBeNull();
  expect(m2, 'shader has no p2 hinge rotation').not.toBeNull();
  return { s1: m1![1] === '-' ? -1 : 1, s2: m2![1] === '-' ? -1 : 1 };
}

const GAIN = shaderConst('ANGLE_NUDGE_GAIN');
const MAX_STEP = shaderConst('MAX_ANGLE_STEP');

/** clampAngle, verbatim from the shader: one wrap into (-PI, PI]. */
const clampAngle = (a: number): number =>
  a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a;

/** rotateAroundAxis, verbatim from the shader (Rodrigues, cross(axis, p)). */
function rotateAroundAxis(p: Vec3, axis: Vec3, angle: number): Vec3 {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  return add3(scale(cosA, p), scale(sinA, cross(axis, p)), scale(dot(axis, p) * (1 - cosA), axis));
}

/** The shader's dihedral: n1 = cross(p1-hingeA, p1-hingeB), n2 = cross(p2-hingeB, p2-hingeA). */
function dihedral(v1: Vec3, v2: Vec3, hingeA: Vec3, hingeB: Vec3): number {
  const edgeDir = normalize(sub(hingeB, hingeA));
  const n1 = normalize(cross(sub(v1, hingeA), sub(v1, hingeB)));
  const n2 = normalize(cross(sub(v2, hingeB), sub(v2, hingeA)));
  return clampAngle(Math.atan2(dot(cross(n1, n2), edgeDir), clamp(dot(n1, n2), -1, 1)));
}

/**
 * One flat hinge (two coplanar triangles sharing the z axis), iterated with the shader's angular
 * fold update. Both opposite vertices have equal weight, so w1Scale = w2Scale = 0.5.
 */
function foldHinge(signs: { s1: number; s2: number }, target: number, iterations: number): number {
  const hingeA: Vec3 = [0, 0, 0];
  const hingeB: Vec3 = [0, 0, 10];
  const hingeMid = scale(0.5, add(hingeA, hingeB));
  const edgeDir = normalize(sub(hingeB, hingeA));
  let v1: Vec3 = [-5, 0, 5];
  let v2: Vec3 = [5, 0, 5];
  for (let i = 0; i < iterations; i++) {
    const error = clampAngle(dihedral(v1, v2, hingeA, hingeB) - target);
    const angleStep = clamp(error * GAIN, -MAX_STEP, MAX_STEP);
    v1 = add(hingeMid, rotateAroundAxis(sub(v1, hingeMid), edgeDir, signs.s1 * angleStep * 0.5));
    v2 = add(hingeMid, rotateAroundAxis(sub(v2, hingeMid), edgeDir, signs.s2 * angleStep * 0.5));
  }
  return dihedral(v1, v2, hingeA, hingeB);
}

const degrees = (radians: number): number => (radians * 180) / Math.PI;
const radians = (deg: number): number => (deg * Math.PI) / 180;

describe('bendingConstraintWGSL angular fold path', () => {
  it('mirrors the dihedral algebra this suite ports', () => {
    // The CPU port above is hand-written (the fold path is inlined in main() around storage
    // buffers, so it cannot be extracted the way the closest-point function can). These are the
    // lines it mirrors; if any of them changes, the port is stale and must be revisited.
    for (const line of [
      'var n1 = cross(p1 - hingeA, p1 - hingeB);',
      'var n2 = cross(p2 - hingeB, p2 - hingeA);',
      'let sinPhi = dot(cross(n1, n2), edgeDir);',
      'let cosPhi = clamp(dot(n1, n2), -1.0, 1.0);',
      'var phi = clampAngle(atan2(sinPhi, cosPhi));',
      'let error = clampAngle(phi - targetAngle);',
      'let angleStep = clamp(error * ANGLE_NUDGE_GAIN, -MAX_ANGLE_STEP, MAX_ANGLE_STEP);',
      'return p * cosA + cross(axis, p) * sinA + axis * dot(axis, p) * (1.0 - cosA);'
    ]) {
      expect(bendingSrc).toContain(line);
    }
  });

  it('rotates the two opposite vertices in opposite senses', () => {
    const { s1, s2 } = nudgeSigns(bendingSrc);
    expect(s1 * s2).toBe(-1);
  });

  it('reduces the dihedral error on every single iteration', () => {
    // The defining property: the nudge must shrink |error|. The shipped signs grew it, and only
    // came to rest because clampAngle's wrap at +/-PI is a fixed point half a turn away.
    const signs = nudgeSigns(bendingSrc);
    const hingeA: Vec3 = [0, 0, 0];
    const hingeB: Vec3 = [0, 0, 10];
    const hingeMid = scale(0.5, add(hingeA, hingeB));
    const edgeDir = normalize(sub(hingeB, hingeA));
    for (const targetDeg of [-120, -45, 30, 90, 150]) {
      const target = radians(targetDeg);
      let v1: Vec3 = [-5, 0, 5];
      let v2: Vec3 = [5, 0, 5];
      const error = clampAngle(dihedral(v1, v2, hingeA, hingeB) - target);
      const before = Math.abs(error);
      const angleStep = clamp(error * GAIN, -MAX_STEP, MAX_STEP);
      v1 = add(hingeMid, rotateAroundAxis(sub(v1, hingeMid), edgeDir, signs.s1 * angleStep * 0.5));
      v2 = add(hingeMid, rotateAroundAxis(sub(v2, hingeMid), edgeDir, signs.s2 * angleStep * 0.5));
      const after = Math.abs(clampAngle(dihedral(v1, v2, hingeA, hingeB) - target));
      expect(after, `target ${targetDeg}deg`).toBeLessThan(before);
    }
  });

  it('settles a hinge at the angle it was asked for', () => {
    const signs = nudgeSigns(bendingSrc);
    for (const targetDeg of [30, 60, 90, 120, 179, -60]) {
      const settled = degrees(foldHinge(signs, radians(targetDeg), 20_000));
      expect(settled, `target ${targetDeg}deg`).toBeCloseTo(targetDeg, 0);
    }
  });

  it('would fail if the rotation signs were swapped back', () => {
    // Swapping the signs does not mirror the fold, it offsets it by half a turn: the hinge rests
    // at target - 180 * sign(target). The two only coincide at +/-90deg, which is why the one
    // non-zero fold angle in the repository (build.test.ts) never caught this.
    const { s1, s2 } = nudgeSigns(bendingSrc);
    const swapped = { s1: -s1, s2: -s2 };
    for (const targetDeg of [30, 60, 120, 179]) {
      const settled = degrees(foldHinge(swapped, radians(targetDeg), 20_000));
      expect(settled, `target ${targetDeg}deg`).toBeCloseTo(targetDeg - 180, 0);
      expect(Math.abs(settled - targetDeg)).toBeGreaterThan(1);
    }
  });
});
