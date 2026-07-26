<script lang="ts">
  import type { Editor } from '@atelier/core';
  import { editorState } from '@atelier/svelte';
  import { selectedTool, zoom } from '$lib/stores/pattern';
  import type { Pattern } from '@seamer/pattern-model';

  interface Props {
    currentPattern: Pattern;
    editor: Editor<Pattern>;
    onchange: (p: Pattern) => void;
  }

  let { currentPattern, editor, onchange }: Props = $props();
  // svelte-ignore state_referenced_locally -- parent keys this component by Editor identity
  const editorView = editorState(editor);

  const tools: { id: string; icon: string; label: string; hotkey?: string }[] = [
    { id: 'select', icon: '&#x2B9F;', label: 'Select', hotkey: 'V' },
    { id: 'pan', icon: '&#x270B;', label: 'Pan', hotkey: 'H' },
    { id: 'measure', icon: '&#x2194;', label: 'Measure', hotkey: 'M' }
  ];

  function toggleGrid() { onchange({ ...currentPattern, showGrid: !currentPattern.showGrid }); }
  function togglePieceNames() { onchange({ ...currentPattern, showPieceNames: !currentPattern.showPieceNames }); }
  function toggleTextures() { onchange({ ...currentPattern, show2dTextures: !(currentPattern.show2dTextures ?? true) }); }
  function zoomIn() { zoom.update((v) => Math.min(20, v * 1.25)); }
  function zoomOut() { zoom.update((v) => Math.max(0.02, v * 0.8)); }

  function handleKeydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return; // plain keys only (Cmd+V etc. are app-level)
    // M doubles as "mirror selection" — an active selection wins over the measure tool
    if (e.key.toLowerCase() === 'm' &&
        (editorView.selection.get('point').size || editorView.selection.get('path').size || editorView.selection.get('piece').size)) return;
    const tool = tools.find((t) => t.hotkey?.toLowerCase() === e.key.toLowerCase());
    if (tool) selectedTool.set(tool.id);
  }

  $effect(() => {
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });
</script>

<div class="flex items-center h-full px-1 gap-0.5 overflow-x-auto">
  <div class="join join-horizontal">
    {#each tools as tool}
      <button
        class="join-item btn btn-xs tooltip tooltip-top"
        data-tip="{tool.label}{tool.hotkey ? ' (' + tool.hotkey + ')' : ''}"
        class:btn-active={$selectedTool === tool.id}
        onclick={() => selectedTool.set(tool.id)}
      >
        {@html tool.icon}
      </button>
    {/each}
  </div>

  <div class="divider divider-horizontal mx-1"></div>

  <div class="flex items-center gap-0.5">
    <button class="btn btn-xs" class:btn-active={currentPattern.showGrid} onclick={toggleGrid} title="Toggle grid">Grid</button>
    <button class="btn btn-xs" class:btn-active={currentPattern.showPieceNames} onclick={togglePieceNames} title="Toggle piece names">Names</button>
    <button class="btn btn-xs" class:btn-active={currentPattern.show2dTextures ?? true} onclick={toggleTextures} title="Toggle fabric texture fills in the 2D view">Fabric</button>
  </div>

  <div class="divider divider-horizontal mx-1"></div>

  <div class="flex items-center gap-0.5">
    <button class="btn btn-xs" onclick={zoomOut} title="Zoom out">-</button>
    <span class="text-xs tabular-nums w-10 text-center">{Math.round($zoom * 100)}%</span>
    <button class="btn btn-xs" onclick={zoomIn} title="Zoom in">+</button>
  </div>

  <div class="flex-1"></div>

  <span class="text-xs opacity-50 px-2 tabular-nums">
    P:{currentPattern.points.length} · Paths:{currentPattern.paths.length} · Pieces:{currentPattern.pieces.length} · Seams:{currentPattern.seams.length}
  </span>
</div>
