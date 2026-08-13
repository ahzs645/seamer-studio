<script lang="ts">
  import { AssemblyPlayback, type AssemblyRecording, type RecordOptions } from '$lib/timeline/assemblyRecording';
  import { toastError } from '$lib/stores/toast';

  interface Props {
    /** Runs the solver forward with seams closing in assembly order. */
    record: (options: RecordOptions & { from?: 'saved' | 'arranged' }) => Promise<AssemblyRecording | null>;
    /** Paint a recorded frame, or hand the view back to the solver with null. */
    showFrame: (positions: Float32Array | null) => void;
    onclose?: () => void;
    disabled?: boolean;
  }

  let { record, showFrame, onclose, disabled = false }: Props = $props();

  let player = $state<AssemblyPlayback | null>(null);
  let progress = $state(0);
  let playing = $state(false);
  let recording = $state(false);
  let recordedFrames = $state(0);
  let recordedTotal = $state(0);
  let controller: AbortController | null = null;
  let raf = 0;

  const frame = $derived(player?.sample(progress) ?? null);
  const steps = $derived(player?.recording.steps ?? []);
  const sizeMb = $derived(player ? player.byteLength() / (1024 * 1024) : 0);

  function paint(): void {
    const sample = player?.sample(progress);
    if (sample) showFrame(sample.positions);
  }

  async function startRecording(from: 'saved' | 'arranged'): Promise<void> {
    if (recording) return;
    stopPlaying();
    recording = true;
    recordedFrames = 0;
    recordedTotal = 0;
    controller = new AbortController();
    try {
      const result = await record({
        from,
        signal: controller.signal,
        onProgress: (done, total) => { recordedFrames = done; recordedTotal = total; }
      });
      if (!result || result.frames.length === 0) {
        toastError('Nothing was recorded. The pattern needs seams and a working 3D drape.');
        return;
      }
      player = new AssemblyPlayback(result);
      progress = 1;
      paint();
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not record the assembly.');
    } finally {
      recording = false;
      controller = null;
    }
  }

  function cancelRecording(): void {
    controller?.abort();
  }

  function stopPlaying(): void {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function togglePlay(): void {
    if (!player) return;
    if (playing) { stopPlaying(); return; }
    if (progress >= 0.999) progress = 0;
    playing = true;
    let last = performance.now();
    const tick = (now: number) => {
      if (!playing || !player) return;
      const dt = Math.min(200, now - last);
      last = now;
      // the whole recording plays in roughly eight seconds regardless of frame count
      progress = Math.min(1, progress + dt / 8000);
      paint();
      if (progress >= 1) { stopPlaying(); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function scrub(event: Event): void {
    stopPlaying();
    progress = Number((event.currentTarget as HTMLInputElement).value) / 1000;
    paint();
  }

  function jumpTo(stepId: string): void {
    if (!player) return;
    stopPlaying();
    progress = player.progressForStep(stepId);
    paint();
  }

  function close(): void {
    stopPlaying();
    cancelRecording();
    player = null;
    showFrame(null);
    onclose?.();
  }

  $effect(() => () => { stopPlaying(); controller?.abort(); });
</script>

<div class="bg-base-200/95 backdrop-blur rounded-lg shadow-lg p-3 text-xs w-[30rem] max-w-[calc(100vw-2rem)]">
  <div class="flex items-center justify-between mb-2">
    <span class="font-bold">Assembly timeline</span>
    <button class="btn btn-ghost btn-xs btn-circle" onclick={close} aria-label="Close">✕</button>
  </div>

  {#if recording}
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <span>Sewing it together…</span>
        <span class="tabular-nums opacity-70">{recordedFrames}{recordedTotal ? ` / ${recordedTotal}` : ''} frames</span>
      </div>
      <progress class="progress progress-primary w-full" value={recordedFrames} max={Math.max(1, recordedTotal)}></progress>
      <button class="btn btn-xs btn-ghost" onclick={cancelRecording}>Stop</button>
    </div>
  {:else if !player}
    <p class="opacity-70 mb-2">
      Cloth is path-dependent, so the timeline is recorded once and replayed — it cannot be solved at
      a scrub position the way a fold can.
    </p>
    <div class="flex gap-2">
      <button class="btn btn-xs btn-primary" {disabled} onclick={() => startRecording('saved')}>
        Record from the finished form
      </button>
      <button class="btn btn-xs" {disabled} onclick={() => startRecording('arranged')}>
        Record from flat
      </button>
    </div>
  {:else}
    <div class="flex items-center gap-2 mb-2">
      <button class="btn btn-xs btn-circle btn-primary" onclick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
        <span class="material-symbols-rounded text-sm">{playing ? 'pause' : 'play_arrow'}</span>
      </button>
      <input
        class="range range-xs range-primary flex-1"
        type="range" min="0" max="1000" step="1"
        value={Math.round(progress * 1000)}
        oninput={scrub}
        aria-label="Assembly progress"
      />
      <span class="tabular-nums opacity-70 w-10 text-right">{Math.round(progress * 100)}%</span>
    </div>

    <div class="flex items-baseline justify-between gap-2 mb-2">
      <span class="truncate">{frame?.step?.label ?? 'Ready to sew'}</span>
      <span class="tabular-nums opacity-70 shrink-0">
        {frame?.stitchesClosed ?? 0} / {player.recording.stitchCount} stitches
      </span>
    </div>

    {#if steps.length > 1}
      <div class="flex flex-wrap gap-1 mb-2 max-h-24 overflow-y-auto">
        {#each steps as step (step.id)}
          <button
            class="btn btn-xs"
            class:btn-active={frame?.step?.id === step.id}
            onclick={() => jumpTo(step.id)}
            title={step.label}
          >{step.label}</button>
        {/each}
      </div>
    {/if}

    <div class="flex items-center justify-between opacity-60">
      <span>{player.frameCount} frames · {sizeMb.toFixed(1)} MB</span>
      <button class="btn btn-xs btn-ghost" onclick={() => { player = null; progress = 0; showFrame(null); }}>
        Re-record
      </button>
    </div>
  {/if}
</div>
