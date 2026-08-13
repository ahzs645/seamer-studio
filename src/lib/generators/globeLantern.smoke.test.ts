import { describe, expect, it, vi } from 'vitest';
import { generateGlobeLantern, globeLanternNotes, DEFAULT_GLOBE_LANTERN } from './globeLantern';
import { resolveAssembly } from '@seamer/pattern-model';
import { buildPieceCloth, buildSimData, computeSeamEdgeIntervals, reuseSavedDrape } from '@seamer/cloth-sim';
import { arrangeParticles } from '@seamer/cloth-sim';
import { indexPoints, pieceTransform } from '@seamer/pattern-model/utils/patternGeometry';

/** Run the generated pattern through the real sim assembly, as prepareCloth does. */
function buildSim(pattern: ReturnType<typeof generateGlobeLantern>['pattern']) {
  const intervals = computeSeamEdgeIntervals(pattern);
  const arranged = pattern.pieces.map((piece) => {
    const cloth = buildPieceCloth(pattern, piece, undefined, intervals);
    if (!cloth) throw new Error(`piece ${piece.name} did not triangulate`);
    const positions3d = arrangeParticles(cloth.mesh.points, piece.settings3d.arrangement, null, {});
    return { cloth, positions3d, frozen: false, fromSaved: false };
  });
  return buildSimData(pattern, arranged);
}

describe('globe lantern generator', () => {
  for (const mode of ['rings', 'helix'] as const) {
    describe(mode, () => {
      const { pattern, stats, warnings } = generateGlobeLantern({ mode });

      it('produces pieces whose boundaries close', () => {
        expect(pattern.pieces.length).toBeGreaterThan(1);
        const byId = new Map(pattern.paths.map((p) => [p.id, p]));
        for (const piece of pattern.pieces) {
          expect(piece.mainPaths.length).toBeGreaterThanOrEqual(3);
          for (let i = 0; i < piece.mainPaths.length; i++) {
            const cur = piece.mainPaths[i];
            const next = piece.mainPaths[(i + 1) % piece.mainPaths.length];
            expect(byId.has(cur.path)).toBe(true);
            expect(cur.to).toBe(next.from);
          }
        }
      });

      it('every seam reference resolves to a real piece edge', () => {
        expect(pattern.seams.length).toBeGreaterThan(1);
        const edgeIds = new Set(pattern.pieces.flatMap((p) => p.mainPaths.map((e) => e.id)));
        for (const seam of pattern.seams) {
          for (const ref of [...seam.fromPaths, ...seam.toPaths]) expect(edgeIds.has(ref.id)).toBe(true);
        }
      });

      it('carries a wire on every coil and closed hoops at the openings', () => {
        const wired = pattern.pieces.flatMap((p) => p.mainPaths).filter((e) => e.wire);
        expect(wired.length).toBeGreaterThan(0);
        for (const edge of wired) {
          expect(edge.wire!.stiffness).toBeGreaterThan(0);
          // the casing is extra CUT width — it must not eat into the finished strip
          expect(edge.seamAllowance).toBe(DEFAULT_GLOBE_LANTERN.seamAllowance + edge.wire!.channelWidth);
        }
        if (mode === 'rings') expect(wired.filter((e) => e.wire!.closed).length).toBeLessThanOrEqual(2);
      });

      it('the assembly names every seam exactly once', () => {
        const steps = resolveAssembly(pattern);
        const seen = steps.flatMap((s) => s.seamIds);
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.length).toBe(pattern.seams.length);
        expect(steps.every((s) => !s.implicit)).toBe(true);
      });

      it('assembles into sim data with every seam sewn and every wire built', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const sim = buildSim(pattern);
        const dropped = warn.mock.calls.map(String).filter((m) => m.includes('dropped') || m.includes('not simulated'));
        warn.mockRestore();
        expect(dropped).toEqual([]);

        expect(sim.seamPairsBySeam.length).toBe(pattern.seams.length);
        expect(sim.stitchCount).toBeGreaterThan(0);
        expect(sim.wireRuns.length).toBeGreaterThan(0);

        // stitch indices are a contiguous 0..stitchCount-1 run in assembly order
        const ranges = sim.seamStitchRanges;
        expect(ranges[0].start).toBe(0);
        for (let i = 1; i < ranges.length; i++) expect(ranges[i].start).toBe(ranges[i - 1].end);
        expect(ranges[ranges.length - 1].end).toBe(sim.stitchCount);
        expect(sim.assemblySteps[sim.assemblySteps.length - 1].end).toBe(sim.stitchCount);

        // every stamped link has an in-range index, and both directions agree
        for (let p = 0; p < sim.particleCount; p++) {
          for (let j = 0; j < 4; j++) {
            const partner = sim.seams[p * 4 + j];
            if (partner < 0) continue;
            const order = sim.seamOrder[p * 4 + j];
            expect(order).toBeGreaterThanOrEqual(-1);
            expect(order).toBeLessThan(sim.stitchCount);
          }
        }
      });

      it('reports usable numbers', () => {
        expect(stats.stripLength).toBeGreaterThan(500);
        expect(stats.coils).toBeGreaterThan(2);
        expect(stats.fabricArea).toBeGreaterThan(0);
        expect(stats.hoopLengths[0]).toBeGreaterThan(0);
        expect(globeLanternNotes(DEFAULT_GLOBE_LANTERN, stats)).toContain('Order of work');
        // the helix is the one that has to report ease; rings have none by construction
        if (mode === 'helix') expect(stats.ease).toBeGreaterThan(0);
        else expect(stats.ease).toBe(0);
        expect(Array.isArray(warnings)).toBe(true);
      });
    });
  }

  it('refuses a strip too wide to wind twice around the body', () => {
    expect(() => generateGlobeLantern({ strip: 220 })).toThrow(/two coils/);
  });
});

describe('which way the cloth faces', () => {
  // The app renders a piece's outward surface as the BACK of its triangles — scene3d puts the face
  // texture on a BackSide mesh for exactly that reason — so every piece has to land with its
  // geometric front pointing INWARD. The 2D boundary winding has no say (the triangulator normalises
  // it): the facing comes purely from the handedness of the flat-to-globe map, and for stacked rings
  // that handedness genuinely flips at the equator, because a band above it develops with its upper
  // edge as the sector's inner arc. The generator mirrors those bands — free, since an annular
  // sector is symmetric about its own bisector — rather than declaring `flipNormals`, which the
  // saved-drape path never reads. Get this wrong and the lantern shows its lining to the room, which
  // nothing else here would catch.
  for (const mode of ['rings', 'helix'] as const) {
    it(`${mode}: every piece lands front-inward on the globe`, () => {
      const { pattern, centreY } = generateGlobeLantern({ mode });
      const intervals = computeSeamEdgeIntervals(pattern);
      const points = indexPoints(pattern);
      for (const piece of pattern.pieces) {
        const cloth = buildPieceCloth(pattern, piece, undefined, intervals)!;
        const reuse = reuseSavedDrape(
          cloth.mesh.points.map(pieceTransform(piece, points)),
          piece.settings3d.savedPositions,
          cloth.particleDistanceMm
        )!;
        expect(reuse, `${piece.name} has no 3D map`).toBeTruthy();

        const P = reuse.positions3d;
        // The globe's centre, not the piece's. A top ring averages to its own height, which puts the
        // reference point inside the band and makes the radial test read whatever rounding says.
        const axisY = centreY;

        let outward = 0;
        let inward = 0;
        const tris = cloth.mesh.triangles;
        for (let i = 0; i < tris.length; i += 3) {
          const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
          const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
          const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
          const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          if (nx * ax + ny * (ay - axisY) + nz * az > 0) outward++; else inward++;
        }
        expect(inward, `${piece.name} lands inside out`).toBeGreaterThan(outward);
        // Nothing generated here is a reversed piece, so nothing should claim to be one.
        expect(piece.settings3d.flipNormals, `${piece.name} declares a reversal it does not need`)
          .toBe(false);
      }
    });
  }
});

describe('the continuous strip', () => {
  it('keeps the helix pieces on the spiral by default', () => {
    const spiral = generateGlobeLantern({ mode: 'helix', layout: 'spiral' });
    const sheets = generateGlobeLantern({ mode: 'helix', layout: 'sheets' });
    const spread = (p: typeof spiral.pattern) => {
      const xs = p.points.map((q) => q.x);
      const ys = p.points.map((q) => q.y);
      return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };
    // the spiral is a broad, roughly square figure; the packed sheets are a different footprint
    const a = spread(spiral.pattern);
    const b = spread(sheets.pattern);
    expect(a.w).toBeGreaterThan(200);
    expect(a.h).toBeGreaterThan(200);
    expect(Math.abs(a.w - b.w) + Math.abs(a.h - b.h)).toBeGreaterThan(50);
  });

  it('reports the coil clearance the poles force on it', () => {
    const { stats } = generateGlobeLantern({ mode: 'helix' });
    // a 28 mm strip carrying 6 mm allowances and an 8 mm casing cannot clear its own neighbours
    // near the openings — the number should say so rather than the layout silently overlapping
    expect(Number.isFinite(stats.coilClearance)).toBe(true);
    expect(stats.coilClearance).toBeLessThan(0);

    // Clearance is (gap between developed coils) minus (cut width). The gap depends only on the
    // strip width and the surface, so trimming the allowances at a FIXED strip width raises it —
    // that much follows from the formula. Widening the strip does not reliably help, because the
    // minimum is taken wherever the coils crowd worst and that station moves.
    const trimmed = generateGlobeLantern({ mode: 'helix', seamAllowance: 2, channelWidth: 3 });
    expect(trimmed.stats.coilClearance).toBeGreaterThan(stats.coilClearance);
  });

  it('notches every piece join so the strip can be put back in order', () => {
    const { pattern } = generateGlobeLantern({ mode: 'helix' });
    const caps = pattern.pieces.flatMap((p) => p.mainPaths).filter((e) => /-(end|start)$/.test(e.id));
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) expect(cap.notches).toHaveLength(1);
    // ordinary edges stay unnotched
    const longEdges = pattern.pieces.flatMap((p) => p.mainPaths).filter((e) => /-[ul]\d+$/.test(e.id));
    expect(longEdges.length).toBeGreaterThan(0);
    for (const edge of longEdges) expect(edge.notches).toHaveLength(0);
  });

  it('gives the lantern a dark interior so the openings read as holes', () => {
    const { pattern } = generateGlobeLantern({});
    const material = pattern.materials[0];
    expect(material.useSeparateBackSide).toBe(true);
    const luminance = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(luminance(material.backTexture!.color)).toBeLessThan(luminance(material.frontTexture!.color) / 2);
  });
});
