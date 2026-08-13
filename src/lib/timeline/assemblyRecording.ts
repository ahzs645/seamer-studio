// The assembly timeline: watching a garment sew itself together.
//
// PackCAD's folding timeline can be solved at any scrub position, because rigid origami is a
// function of its crease angles — `solveFoldTimeline(model, step, angle)` is stateless and cached.
// Cloth is not. XPBD is path-dependent: where the fabric ends up depends on the order it got there,
// and there is no way to solve "70% sewn" from scratch. So this timeline is a RECORDING, not a
// function. Run it forward once, snapshot as it goes, and let scrubbing replay the snapshots.
//
// That is a constraint, but it is also the right shape for the job: sewing instructions want a
// repeatable take, not a fresh simulation every time someone drags the scrubber.

export interface SewableSim {
  /** Total gated stitches — the top of the timeline. */
  readonly stitchCount: number;
  /** Close every stitch below `count`; the rest stay loose. */
  setSewnUpTo(count: number): void;
  /** Advance one frame and return the global stride-4 position buffer. */
  step(): Promise<Float32Array>;
  /**
   * Re-seed to the state the recording starts from. What that means is the caller's call: a
   * garment arranged on a body genuinely assembles from its arrangement, while a generated lantern
   * already knows where every piece lands and starts from there with its seams open.
   */
  reset(): void;
}

export interface AssemblyStepSpan {
  id: string;
  label: string;
  start: number;
  end: number;
  settleFrames: number;
}

export interface RecordOptions {
  /**
   * Upper bound on recorded frames. Every frame holds three floats per particle, so this is the
   * memory dial: 20k particles at 150 frames is about 36 MB.
   */
  maxFrames?: number;
  /** Hard ceiling on recording size; frames are thinned to stay under it. */
  maxBytes?: number;
  /** Frames run before the first stitch closes, letting loose panels fall into place. */
  leadFrames?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface AssemblyRecording {
  /** Particle positions per frame, stride 3 (x, y, z) in metres. */
  frames: Float32Array[];
  /** Stitches closed at each frame, parallel to `frames`. */
  stitches: number[];
  particleCount: number;
  stitchCount: number;
  steps: AssemblyStepSpan[];
}

const DEFAULT_MAX_FRAMES = 150;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function packXYZ(stride4: Float32Array, particleCount: number): Float32Array {
  const out = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i++) {
    out[i * 3] = stride4[i * 4];
    out[i * 3 + 1] = stride4[i * 4 + 1];
    out[i * 3 + 2] = stride4[i * 4 + 2];
  }
  return out;
}

/**
 * Run the garment together from nothing and keep every frame.
 *
 * Stitches close in assembly order; each step then holds for its settle frames so the cloth can
 * relax before the next seam starts pulling. The step boundaries are preserved in the output so the
 * scrubber can name what is being sewn rather than showing a bare percentage.
 */
export async function recordAssembly(
  sim: SewableSim,
  steps: AssemblyStepSpan[],
  particleCount: number,
  options: RecordOptions = {}
): Promise<AssemblyRecording> {
  const stitchCount = sim.stitchCount;
  const lead = Math.max(0, options.leadFrames ?? 8);
  const byFrameBudget = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  const byteBudget = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const bytesPerFrame = particleCount * 3 * 4;
  const maxFrames = Math.max(8, Math.min(byFrameBudget, Math.floor(byteBudget / Math.max(1, bytesPerFrame))));

  const settleTotal = steps.reduce((sum, step) => sum + step.settleFrames, 0);
  const sewFrames = Math.max(1, maxFrames - lead - settleTotal);
  const stitchesPerFrame = Math.max(1, Math.ceil(stitchCount / sewFrames));

  const frames: Float32Array[] = [];
  const stitches: number[] = [];
  const estimate = lead + Math.ceil(stitchCount / stitchesPerFrame) + settleTotal;

  const capture = async (sewn: number) => {
    sim.setSewnUpTo(sewn);
    const positions = await sim.step();
    frames.push(packXYZ(positions, particleCount));
    stitches.push(sewn);
    options.onProgress?.(frames.length, estimate);
  };
  const aborted = () => options.signal?.aborted === true;

  sim.reset();
  sim.setSewnUpTo(0);
  for (let i = 0; i < lead; i++) {
    if (aborted()) break;
    await capture(0);
  }

  let sewn = 0;
  for (const step of steps) {
    while (sewn < step.end) {
      if (aborted()) break;
      sewn = Math.min(step.end, sewn + stitchesPerFrame);
      await capture(sewn);
    }
    for (let i = 0; i < step.settleFrames; i++) {
      if (aborted()) break;
      await capture(sewn);
    }
    if (aborted()) break;
  }
  // Steps can leave stitches unclaimed if the assembly and the sim disagree; close the remainder.
  while (!aborted() && sewn < stitchCount) {
    sewn = Math.min(stitchCount, sewn + stitchesPerFrame);
    await capture(sewn);
  }

  return { frames, stitches, particleCount, stitchCount, steps };
}

/* ------------------------------------------------------------------ *
 *  Playback
 * ------------------------------------------------------------------ */

export interface PlaybackFrame {
  /** Stride-4 positions, ready for the renderer. Reused between calls — copy if you keep it. */
  positions: Float32Array;
  frameIndex: number;
  stitchesClosed: number;
  /** 0..1 across the whole recording. */
  progress: number;
  step: AssemblyStepSpan | null;
  /** 0..1 within the active step. */
  stepProgress: number;
}

/**
 * Scrubbing over a recording. Positions are interpolated between the two nearest frames, which
 * keeps a slow drag smooth without recording at playback resolution.
 */
export class AssemblyPlayback {
  readonly recording: AssemblyRecording;
  #scratch: Float32Array;

  constructor(recording: AssemblyRecording) {
    this.recording = recording;
    this.#scratch = new Float32Array(recording.particleCount * 4);
  }

  get frameCount(): number {
    return this.recording.frames.length;
  }

  /** Sample the recording at `t` in 0..1. */
  sample(t: number): PlaybackFrame | null {
    const { frames, stitches, particleCount, steps } = this.recording;
    if (frames.length === 0) return null;
    const clamped = Math.min(1, Math.max(0, t));
    const exact = clamped * (frames.length - 1);
    const lo = Math.floor(exact);
    const hi = Math.min(frames.length - 1, lo + 1);
    const f = exact - lo;

    const a = frames[lo];
    const b = frames[hi];
    const out = this.#scratch;
    for (let i = 0; i < particleCount; i++) {
      out[i * 4] = a[i * 3] + (b[i * 3] - a[i * 3]) * f;
      out[i * 4 + 1] = a[i * 3 + 1] + (b[i * 3 + 1] - a[i * 3 + 1]) * f;
      out[i * 4 + 2] = a[i * 3 + 2] + (b[i * 3 + 2] - a[i * 3 + 2]) * f;
    }

    const closed = Math.round(stitches[lo] + (stitches[hi] - stitches[lo]) * f);
    const step = steps.find((s) => closed >= s.start && closed < s.end)
      ?? (closed >= (steps[steps.length - 1]?.end ?? 0) ? steps[steps.length - 1] ?? null : null);
    const span = step ? Math.max(1, step.end - step.start) : 1;
    return {
      positions: out,
      frameIndex: lo,
      stitchesClosed: closed,
      progress: clamped,
      step: step ?? null,
      stepProgress: step ? Math.min(1, Math.max(0, (closed - step.start) / span)) : 0
    };
  }

  /** The playhead position where a step begins, for click-to-step in the transport. */
  progressForStep(stepId: string): number {
    const { frames, stitches, steps } = this.recording;
    const step = steps.find((s) => s.id === stepId);
    if (!step || frames.length < 2) return 0;
    const index = stitches.findIndex((s) => s >= step.start);
    return index < 0 ? 0 : index / (frames.length - 1);
  }

  byteLength(): number {
    return this.recording.frames.reduce((sum, frame) => sum + frame.byteLength, 0);
  }
}
