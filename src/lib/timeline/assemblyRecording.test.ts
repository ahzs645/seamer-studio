import { describe, expect, it, vi } from 'vitest';
import {
  AssemblyPlayback,
  recordAssembly,
  type AssemblyStepSpan,
  type SewableSim
} from './assemblyRecording';

/** A stand-in for the GPU solver: records the gate it was asked for, one particle per stitch. */
function fakeSim(stitchCount: number, particleCount = 4): SewableSim & { gates: number[] } {
  let sewn = 0;
  let frame = 0;
  return {
    gates: [] as number[],
    stitchCount,
    setSewnUpTo(count) { sewn = count; },
    reset() { frame = 0; },
    async step() {
      this.gates.push(sewn);
      frame++;
      const out = new Float32Array(particleCount * 4);
      // positions encode (frame, sewn) so interpolation is checkable
      for (let i = 0; i < particleCount; i++) {
        out[i * 4] = frame;
        out[i * 4 + 1] = sewn;
        out[i * 4 + 2] = i;
        out[i * 4 + 3] = 1;
      }
      return out;
    }
  };
}

const steps = (spans: [string, number, number, number][]): AssemblyStepSpan[] =>
  spans.map(([id, start, end, settleFrames]) => ({ id, label: id, start, end, settleFrames }));

describe('recordAssembly', () => {
  it('closes stitches in order and never runs backwards', async () => {
    const sim = fakeSim(100);
    const rec = await recordAssembly(sim, steps([['a', 0, 40, 2], ['b', 40, 100, 3]]), 4, { leadFrames: 4 });
    expect(rec.stitches[0]).toBe(0);
    expect(rec.stitches[rec.stitches.length - 1]).toBe(100);
    for (let i = 1; i < rec.stitches.length; i++) {
      expect(rec.stitches[i]).toBeGreaterThanOrEqual(rec.stitches[i - 1]);
    }
    expect(rec.frames.length).toBe(rec.stitches.length);
  });

  it('holds the gate steady through each step settle', async () => {
    const sim = fakeSim(20);
    const rec = await recordAssembly(sim, steps([['a', 0, 20, 5]]), 4, { leadFrames: 0, maxFrames: 40 });
    const tail = rec.stitches.slice(-5);
    expect(tail).toEqual([20, 20, 20, 20, 20]);
  });

  it('runs lead frames with nothing sewn', async () => {
    const sim = fakeSim(10);
    const rec = await recordAssembly(sim, steps([['a', 0, 10, 0]]), 4, { leadFrames: 6 });
    expect(rec.stitches.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('respects the frame budget rather than recording one frame per stitch', async () => {
    const sim = fakeSim(100000);
    const rec = await recordAssembly(sim, steps([['a', 0, 100000, 2]]), 100, { maxFrames: 30, leadFrames: 2 });
    expect(rec.frames.length).toBeLessThanOrEqual(40);
    expect(rec.stitches[rec.stitches.length - 1]).toBe(100000);
  });

  it('thins frames to stay inside the memory ceiling', async () => {
    const sim = fakeSim(5000);
    // 1000 particles * 3 floats * 4 bytes = 12 KB per frame; a 120 KB ceiling allows 10
    const rec = await recordAssembly(sim, steps([['a', 0, 5000, 0]]), 1000, {
      maxFrames: 500, maxBytes: 120 * 1024, leadFrames: 0
    });
    expect(rec.frames.length).toBeLessThanOrEqual(12);
  });

  it('stops early when aborted', async () => {
    const controller = new AbortController();
    const sim = fakeSim(1000);
    const onProgress = vi.fn(() => { if (onProgress.mock.calls.length >= 3) controller.abort(); });
    const rec = await recordAssembly(sim, steps([['a', 0, 1000, 0]]), 4, {
      leadFrames: 0, signal: controller.signal, onProgress
    });
    expect(rec.frames.length).toBeLessThan(10);
    expect(rec.stitches[rec.stitches.length - 1]).toBeLessThan(1000);
  });

  it('closes any stitches the assembly steps left unclaimed', async () => {
    const sim = fakeSim(50);
    // steps only cover 0..30
    const rec = await recordAssembly(sim, steps([['a', 0, 30, 0]]), 4, { leadFrames: 0 });
    expect(rec.stitches[rec.stitches.length - 1]).toBe(50);
  });
});

describe('AssemblyPlayback', () => {
  it('interpolates between frames and reports the active step', async () => {
    const sim = fakeSim(100);
    const rec = await recordAssembly(sim, steps([['a', 0, 50, 1], ['b', 50, 100, 1]]), 4, { leadFrames: 2 });
    const player = new AssemblyPlayback(rec);

    const start = player.sample(0)!;
    expect(start.stitchesClosed).toBe(0);
    expect(start.progress).toBe(0);

    const end = player.sample(1)!;
    expect(end.stitchesClosed).toBe(100);
    expect(end.step?.id).toBe('b');

    // stride-4 output, xyz filled
    expect(end.positions.length).toBe(4 * 4);
    expect(end.positions[2]).toBe(0);
    expect(end.positions[6]).toBe(1);
  });

  it('clamps out-of-range scrub positions', async () => {
    const sim = fakeSim(10);
    const rec = await recordAssembly(sim, steps([['a', 0, 10, 0]]), 4, { leadFrames: 0 });
    const player = new AssemblyPlayback(rec);
    expect(player.sample(-5)!.progress).toBe(0);
    expect(player.sample(9)!.progress).toBe(1);
  });

  it('locates where each step starts', async () => {
    const sim = fakeSim(100);
    const rec = await recordAssembly(sim, steps([['a', 0, 50, 1], ['b', 50, 100, 1]]), 4, { leadFrames: 2 });
    const player = new AssemblyPlayback(rec);
    expect(player.progressForStep('a')).toBe(0);
    const b = player.progressForStep('b');
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThanOrEqual(1);
    expect(player.sample(b)!.stitchesClosed).toBeGreaterThanOrEqual(50);
  });

  it('returns null for an empty recording', () => {
    const player = new AssemblyPlayback({ frames: [], stitches: [], particleCount: 4, stitchCount: 0, steps: [] });
    expect(player.sample(0.5)).toBeNull();
  });
});
