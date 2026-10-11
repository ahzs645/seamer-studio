<script lang="ts">
  import { onMount } from 'svelte';
  import type { Pattern } from '@seamer/pattern-model';
  import { pattern as patternStore, getPatternEditor, setDocumentMutationLock } from '$lib/stores/pattern';
  import PatternCanvas2D from '$lib/components/PatternCanvas2D.svelte';
  import PatternScene3D from '$lib/components/PatternScene3D.svelte';
  import StudioToolbar from '$lib/components/StudioToolbar.svelte';
  import { capturedSourceStretchPolicy, capturedSourceAssemblyComplete, compatibleSourceBodyCheckpoint, SOURCE_BODY_FIT_REVISION, GARMENT_CODE_ASSEMBLY_REVISION } from '$lib/scene/sourceBodyCheckpoint';
  import type { SourceGatherCacheMarker } from '$lib/utils/sourceGatherPreparation';
  import SpecsPanel from '$lib/components/SpecsPanel.svelte';
  import type { DetachedMessage, DetachedPane } from '$lib/utils/detachedWorkspace';
  let pane = $state<DetachedPane>('2d'), current = $state<Pattern | null>(null), revision = 0;
  let readonly = $state(true), connected = $state(false), error = $state('Waiting for the main workspace…');
  let channel: BroadcastChannel | null = null, lastSeen = 0;
  let editTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingDraft: { pattern: Pattern; label?: string; revision: number } | null = null;
  function edit(pattern: Pattern, label?: string) {
    if (!connected || readonly) return;
    const snapshot = $state.snapshot(pattern);
    if (pane !== '2d') { channel?.postMessage({ type: 'edit', pattern: snapshot, revision, label } satisfies DetachedMessage); return; }
    // Canvas drags update locally and commit once idle, keeping the parent history authoritative.
    current = snapshot; patternStore.set(snapshot);
    pendingDraft = { pattern: snapshot, label, revision };
    clearTimeout(editTimer);
    editTimer = setTimeout(() => { if (pendingDraft && connected && !readonly) channel?.postMessage({ type: 'edit', ...pendingDraft } satisfies DetachedMessage); pendingDraft = null; }, 120);
  }
  function camera(position: [number, number, number], target: [number, number, number], fov: number) {
    if (!current || readonly || !connected) return;
    edit({ ...current, settings3d: { ...current.settings3d, cameraPosition: position, controlsTarget: target, cameraFov: fov, sourceCameraFraming: undefined } }, 'Move detached camera');
  }
  function settled(savedByPiece: Record<string, number[]>, stretch: Parameters<typeof capturedSourceStretchPolicy>[1], complete: boolean | null, gather?: SourceGatherCacheMarker, intent?: 'manual') {
    if (!current || readonly || !connected) return;
    const source = current.garmentCodeSource, compatible = compatibleSourceBodyCheckpoint(current);
    const pieces = current.pieces.map((piece, index) => savedByPiece[piece.id] ? { ...piece, settings3d: { ...piece.settings3d, savedPositions: savedByPiece[piece.id],
      ...(source ? { savedDrapeState: compatible.pieces[index].settings3d.savedDrapeState === 'held' ? 'held' as const : 'checkpoint' as const,
        savedBodyFitRevision: SOURCE_BODY_FIT_REVISION, savedAssemblyRevision: GARMENT_CODE_ASSEMBLY_REVISION,
        savedSourceStretchPolicy: capturedSourceStretchPolicy(piece.id, stretch), savedSourceGatherPolicy: gather, savedSourceGatherIntent: intent,
        savedSourceAssemblyComplete: capturedSourceAssemblyComplete(piece.id, stretch, complete) } : {}) } } : piece);
    edit({ ...current, pieces }, 'Save detached drape');
  }
  function history(type: 'undo' | 'redo') { if (connected && !readonly) channel?.postMessage({ type, revision } satisfies DetachedMessage); }
  onMount(() => {
    const [requested, room] = location.hash.slice(1).split('/');
    if (!['2d', '3d', 'specs'].includes(requested) || !/^[a-f\d-]{36}$/.test(room ?? '') || typeof BroadcastChannel === 'undefined') { error = 'Open this pane from a Seamer workspace.'; return; }
    pane = requested as DetachedPane;
    channel = new BroadcastChannel(`seamer-detached-${room}`);
    channel.onmessage = (event: MessageEvent<DetachedMessage>) => {
      const message = event.data;
      if (message.type === 'state') {
        lastSeen = Date.now();
        if (pendingDraft && message.revision === revision && !message.readonly) return;
        if (pendingDraft) { clearTimeout(editTimer); pendingDraft = null; error = 'The main document changed during this gesture. Retry on the updated document.'; }
        if (!connected) error = '';
        lastSeen = Date.now(); connected = true; readonly = message.readonly; revision = message.revision;
        current = message.pattern; setDocumentMutationLock(null); patternStore.set(message.pattern); setDocumentMutationLock(readonly ? 'Detached document is read-only.' : null);
      } else if (message.type === 'error') error = message.message;
      else if (message.type === 'closed') { connected = false; readonly = true; setDocumentMutationLock('Detached workspace disconnected.'); error = 'The main workspace closed. This pane is read-only.'; }
    };
    channel.postMessage({ type: 'hello' } satisfies DetachedMessage);
    const timer = setInterval(() => { channel?.postMessage({ type: 'heartbeat' } satisfies DetachedMessage); if (lastSeen && Date.now() - lastSeen > 7000) { connected = false; readonly = true; setDocumentMutationLock('Detached workspace disconnected.'); error = 'Connection to the main workspace was lost.'; } }, 2000);
    const closed = () => channel?.postMessage({ type: 'closed' } satisfies DetachedMessage);
    window.addEventListener('beforeunload', closed);
    return () => { closed(); channel?.close(); clearInterval(timer); clearTimeout(editTimer); window.removeEventListener('beforeunload', closed); };
  });
</script>
<svelte:head><title>Seamer · detached {pane === '2d' ? 'Draft' : pane === '3d' ? 'Garment' : 'Specs'}</title></svelte:head>
<div class="detached-shell">
  <header><strong>Seamer · {pane === '2d' ? 'Draft' : pane === '3d' ? 'Garment' : 'Specs'}</strong><span>{readonly ? 'Read-only' : 'Changes sync to the main workspace'}</span><button class="btn btn-xs" disabled={readonly || !connected} onclick={() => history('undo')}>Undo</button><button class="btn btn-xs" disabled={readonly || !connected} onclick={() => history('redo')}>Redo</button></header>
  {#if error}<p class="notice" role="status">{error}</p>{/if}
  {#if current}<main inert={(readonly || !connected) && pane === '2d'}>
    {#if pane === '2d'}<div class="draft-toolbar"><StudioToolbar currentPattern={current} editor={getPatternEditor()} onchange={edit} /></div><PatternCanvas2D currentPattern={current} editor={getPatternEditor()} onchange={edit} />
    {:else if pane === '3d'}<PatternScene3D currentPattern={current} readOnly={readonly || !connected} onpatternupdate={edit} ondocumentchange={edit} oncamerachange={camera} ondrapesettled={settled} />
    {:else}<SpecsPanel pattern={current} readOnly={readonly || !connected} onchange={edit} />{/if}
  </main>{/if}
</div>
<style>.detached-shell{height:100dvh;display:flex;flex-direction:column;background:var(--color-base-100,#fff)}header{display:flex;gap:.7rem;align-items:center;flex-wrap:wrap;padding:.5rem;border-bottom:1px solid #8884}header span{font-size:.75rem;margin-left:auto}.draft-toolbar{height:30px;position:absolute;inset:0 0 auto;z-index:20;background:var(--color-base-100,#fff)}main{flex:1;min-height:0;overflow:auto;position:relative}.notice{padding:.5rem;color:var(--color-error,#b11)}</style>
