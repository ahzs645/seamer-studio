<script lang="ts">
	import { get } from 'svelte/store';
	import type { Editor } from '@atelier/core';
	import { editorState } from '@atelier/svelte';
	import { selectedSeamId } from '$lib/stores/pattern';
	import {
		deletePath,
		deletePoint,
		deletePiece,
		deleteSeam,
		deleteText,
		indexPiecePathOwners,
		reorder as reorderItems,
		seamLabel as computeSeamLabel,
		type Pattern,
		type Seam
	} from '@seamer/pattern-model';

	interface Props {
		currentPattern: Pattern;
		editor: Editor<Pattern>;
		onchange: (p: Pattern) => void;
		/** Whether the panel is shown. Bindable so the parent can reopen it. */
		open?: boolean;
	}

	let { currentPattern, editor, onchange, open = $bindable(true) }: Props = $props();
	// svelte-ignore state_referenced_locally -- parent keys this component by Editor identity
	const editorView = editorState(editor);
	const pointIds = $derived(editorView.selection.get('point'));
	const pathIds = $derived(editorView.selection.get('path'));
	const pieceIds = $derived(editorView.selection.get('piece'));

	// ---- Panel chrome (drag + minimize) -------------------------------------
	let pos = $state({ x: 524, y: 69 });
	let dragging = $state(false);
	let dragOffset = { x: 0, y: 0 };
	let minimized = $state(false);

	function startDrag(e: PointerEvent) {
		if ((e.target as HTMLElement).closest('button')) return; // let header buttons work
		dragging = true;
		dragOffset = { x: e.clientX - pos.x, y: e.clientY - pos.y };
		window.addEventListener('pointermove', onDrag);
		window.addEventListener('pointerup', endDrag);
	}
	function onDrag(e: PointerEvent) {
		if (!dragging) return;
		pos = { x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y };
	}
	function endDrag() {
		dragging = false;
		window.removeEventListener('pointermove', onDrag);
		window.removeEventListener('pointerup', endDrag);
	}

	// ---- Tree open/closed state --------------------------------------------
	type GroupKey = 'paths' | 'pieces' | 'points' | 'seams' | 'texts';
	let collapsed = $state<Record<string, boolean>>({});
	let expanded = $state<Record<string, boolean>>({});
	let search = $state('');
	let selectedKey = $state<string | null>(null); // local highlight for seams / text

	const toggleGroup = (k: GroupKey) => (collapsed = { ...collapsed, [k]: !collapsed[k] });
	const toggleItem = (id: string) => (expanded = { ...expanded, [id]: !expanded[id] });

	// ---- Lookups ------------------------------------------------------------
	const pointName = (id: string) => currentPattern.points.find((p) => p.id === id)?.name ?? id;
	// Resolve PiecePath ownership once per pattern change so seam labels read like the original app.
	let owners = $derived(indexPiecePathOwners(currentPattern));
	const seamLabel = (s: Seam) => computeSeamLabel(currentPattern, s, owners);
	const textLabel = (t: { value?: string; name?: string; id: string }) => t.value ?? t.name ?? t.id;

	// ---- Filtering ----------------------------------------------------------
	let q = $derived(search.trim().toLowerCase());
	const hit = (s: string) => !q || s.toLowerCase().includes(q);
	let paths = $derived(currentPattern.paths.filter((p) => hit(p.name)));
	let pieces = $derived(currentPattern.pieces.filter((p) => hit(p.name)));
	let points = $derived(currentPattern.points.filter((p) => hit(p.name)));
	let seams = $derived(currentPattern.seams.filter((s) => hit(seamLabel(s))));
	let texts = $derived(currentPattern.texts.filter((t) => hit(textLabel(t))));

	// ---- Selection (drives the canvas through the shared Editor) ------------
	function selectPoint(id: string) {
		editor.setSelection(editor.selection.replace('point', [id]).clear('path').clear('piece'));
		selectedKey = id;
	}
	function selectPath(id: string) {
		editor.setSelection(editor.selection.replace('path', [id]).clear('point').clear('piece'));
		selectedKey = id;
	}
	function selectPiece(id: string) {
		editor.setSelection(editor.selection.replace('piece', [id]).clear('point').clear('path'));
		selectedKey = id;
	}
	const selectOther = (id: string) => (selectedKey = id);
	// Seam rows also drive the cross-view seam highlight (2D emphasis + 3D display-when-selected).
	const selectSeamRow = (id: string) => {
		selectedKey = id;
		selectedSeamId.set(get(selectedSeamId) === id ? null : id);
	};

	// ---- Mutations (mirror the page's onchange contract) --------------------
	const reorder = (group: GroupKey, fromId: string, toId: string) =>
		onchange(reorderItems(currentPattern, group, fromId, toId));

	/** Cascading delete: removes the object AND anything that can't exist without it (see patternMutations). */
	function removeFrom(group: GroupKey, id: string) {
		const del =
			group === 'paths'
				? deletePath
				: group === 'pieces'
					? deletePiece
					: group === 'points'
						? deletePoint
						: group === 'seams'
							? deleteSeam
							: deleteText;
		onchange(del(currentPattern, id));
	}
	function toggleHidden(id: string) {
		onchange({
			...currentPattern,
			pieces: currentPattern.pieces.map((p) => (p.id === id ? { ...p, hidden: !p.hidden } : p)),
			hasChanged: true
		});
	}

	// ---- Drag-to-reorder within a group ------------------------------------
	let drag: { group: GroupKey; id: string } | null = null;
	const rowDragStart = (group: GroupKey, id: string) => (drag = { group, id });
	function rowDrop(group: GroupKey, id: string) {
		if (drag && drag.group === group) reorder(group, drag.id, id);
		drag = null;
	}
</script>

{#if open}
	<div
		class="fixed max-w-[95vw] md:max-w-[80vw] max-h-[80dvh] z-[65] bg-base-100 flex flex-col border border-base-300 rounded-md shadow-lg shadow-black/30 text-sm w-[95vw] md:w-[25rem] overflow-hidden"
		class:cursor-grabbing={dragging}
		class:cursor-grab={!dragging}
		style="left: {pos.x}px; top: {pos.y}px;"
		data-testid="object-browser"
	>
		<!-- Header / drag handle -->
		<div
			role="button"
			tabindex="-1"
			aria-label="Panel drag handle"
			class="flex items-center p-2 bg-base-300 select-none"
			onpointerdown={startDrag}
		>
			<span class="mr-2 material-symbols-rounded notranslate" aria-hidden="true">view_list</span>
			<span class="font-bold mr-1">Object browser</span>
			<div class="ml-auto">
				<button class="mr-1" type="button" title="Minimize" aria-label="Minimize panel" onclick={() => (minimized = !minimized)}>
					<span class="material-symbols-rounded notranslate" aria-hidden="true">
						{minimized ? 'keyboard_arrow_up' : 'keyboard_arrow_down'}
					</span>
				</button>
				<button type="button" title="Close" aria-label="Close panel" onclick={() => (open = false)}>
					<span class="material-symbols-rounded notranslate" aria-hidden="true">cancel</span>
				</button>
			</div>
		</div>

		{#if !minimized}
			<div class="flex overflow-y-auto">
				<div class="w-full p-2">
					<div class="flex items-center h-8 select-none">
						<span class="text-sm font-medium">Pattern</span>
					</div>
					<div class="ml-4">
						<div class="mb-2">
							<input class="input input-sm input-bordered w-full" type="text" placeholder="Search objects by name" bind:value={search} />
						</div>

						<!-- Paths (expandable) -->
						<div class="flex flex-col w-full">
							<div role="button" tabindex="0" class="flex items-center h-8 cursor-pointer select-none"
								onclick={() => toggleGroup('paths')}
								onkeydown={(e) => e.key === 'Enter' && toggleGroup('paths')}>
								<button class="mr-2" title={collapsed.paths ? 'Expand' : 'Collapse'}>
									<span class="material-symbols-rounded notranslate">{collapsed.paths ? 'add' : 'remove'}</span>
								</button>
								<span class="text-sm">Paths ({paths.length})</span>
							</div>
							{#if !collapsed.paths}
								<div class="ml-4">
									{#each paths as path (path.id)}
										<div role="listitem" draggable="true"
											class="select-none rounded-md px-2 py-1 transition-colors hover:bg-base-200 active:bg-base-300 flex items-center gap-2 cursor-[ns-resize]"
											class:bg-base-200={pathIds.has(path.id)}
											ondragstart={() => rowDragStart('paths', path.id)}
											ondragover={(e) => e.preventDefault()}
											ondrop={(e) => { e.preventDefault(); rowDrop('paths', path.id); }}>
											<span class="material-symbols-rounded text-base-content/70 notranslate" title="Drag to reorder">drag_indicator</span>
											<div class="flex flex-col w-full">
												<div role="button" tabindex="0" class="flex items-center h-8 cursor-pointer select-none" title="Select"
													onclick={() => selectPath(path.id)}
													onkeydown={(e) => e.key === 'Enter' && selectPath(path.id)}>
													<button class="mr-2" title={expanded[path.id] ? 'Collapse' : 'Expand'}
														onclick={(e) => { e.stopPropagation(); toggleItem(path.id); }}>
														<span class="material-symbols-rounded notranslate">{expanded[path.id] ? 'remove' : 'add'}</span>
													</button>
													<span class="text-sm">{path.name}</span>
													<div class="ml-auto">
														<button class="ml-1" title="Delete" onclick={(e) => { e.stopPropagation(); removeFrom('paths', path.id); }}>
															<span class="material-symbols-rounded notranslate">delete</span>
														</button>
													</div>
												</div>
												{#if expanded[path.id]}
													<div class="ml-6 text-xs opacity-70 pb-1">
														<div>Type: {path.pathType}</div>
														<div>Points: {path.pathPoints.map((pp) => pointName(pp.id)).join(', ') || '—'}</div>
													</div>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>

						<!-- Pieces (expandable, with visibility toggle) -->
						<div class="flex flex-col w-full">
							<div role="button" tabindex="0" class="flex items-center h-8 cursor-pointer select-none"
								onclick={() => toggleGroup('pieces')}
								onkeydown={(e) => e.key === 'Enter' && toggleGroup('pieces')}>
								<button class="mr-2" title={collapsed.pieces ? 'Expand' : 'Collapse'}>
									<span class="material-symbols-rounded notranslate">{collapsed.pieces ? 'add' : 'remove'}</span>
								</button>
								<span class="text-sm" data-testid="object-browser-pieces-count">Pieces ({pieces.length})</span>
							</div>
							{#if !collapsed.pieces}
								<div class="ml-4">
									{#each pieces as piece (piece.id)}
										<div role="listitem" draggable="true"
											class="select-none rounded-md px-2 py-1 transition-colors hover:bg-base-200 active:bg-base-300 flex items-center gap-2 cursor-[ns-resize]"
											class:bg-base-200={pieceIds.has(piece.id)}
											ondragstart={() => rowDragStart('pieces', piece.id)}
											ondragover={(e) => e.preventDefault()}
											ondrop={(e) => { e.preventDefault(); rowDrop('pieces', piece.id); }}>
											<span class="material-symbols-rounded text-base-content/70 notranslate" title="Drag to reorder">drag_indicator</span>
											<div class="flex flex-col w-full">
												<div role="button" tabindex="0" class="flex items-center h-8 cursor-pointer select-none" title="Select" data-testid="object-browser-piece"
													onclick={() => selectPiece(piece.id)}
													onkeydown={(e) => e.key === 'Enter' && selectPiece(piece.id)}>
													<button class="mr-2" title={expanded[piece.id] ? 'Collapse' : 'Expand'}
														onclick={(e) => { e.stopPropagation(); toggleItem(piece.id); }}>
														<span class="material-symbols-rounded notranslate">{expanded[piece.id] ? 'remove' : 'add'}</span>
													</button>
													<span class="text-sm">{piece.name}</span>
													<div class="ml-auto inline-flex items-center">
														<button class="ml-1" title={piece.hidden ? 'Show piece' : 'Hide piece'}
															onclick={(e) => { e.stopPropagation(); toggleHidden(piece.id); }}>
															<span class="material-symbols-rounded notranslate">{piece.hidden ? 'visibility_off' : 'visibility'}</span>
														</button>
														<button class="ml-1" title="Delete" onclick={(e) => { e.stopPropagation(); removeFrom('pieces', piece.id); }}>
															<span class="material-symbols-rounded notranslate">delete</span>
														</button>
													</div>
												</div>
												{#if expanded[piece.id]}
													<div class="ml-6 text-xs opacity-70 pb-1">
														<div>Paths: {piece.mainPaths.map((mp) => mp.name).join(', ') || '—'}</div>
														{#if piece.internalPaths.length}<div>Internal: {piece.internalPaths.length}</div>{/if}
													</div>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>

						<!-- Points -->
						<div class="flex flex-col w-full">
							<div role="button" tabindex="0" class="flex items-center h-8 cursor-pointer select-none"
								onclick={() => toggleGroup('points')}
								onkeydown={(e) => e.key === 'Enter' && toggleGroup('points')}>
								<button class="mr-2" title={collapsed.points ? 'Expand' : 'Collapse'}>
									<span class="material-symbols-rounded notranslate">{collapsed.points ? 'add' : 'remove'}</span>
								</button>
								<span class="text-sm">Points ({points.length})</span>
							</div>
							{#if !collapsed.points}
								<div class="ml-4">
									{#each points as point (point.id)}
										<div role="listitem" draggable="true"
											class="select-none rounded-md px-2 py-1 transition-colors hover:bg-base-200 active:bg-base-300 flex items-center gap-2 cursor-[ns-resize]"
											class:bg-base-200={pointIds.has(point.id)}
											ondragstart={() => rowDragStart('points', point.id)}
											ondragover={(e) => e.preventDefault()}
											ondrop={(e) => { e.preventDefault(); rowDrop('points', point.id); }}>
											<span class="material-symbols-rounded text-base-content/70 notranslate" title="Drag to reorder">drag_indicator</span>
											<div class="flex flex-col w-full">
												<div role="button" tabindex="0" class="flex items-center h-8 cursor-pointer select-none" title="Select"
													onclick={() => selectPoint(point.id)}
													onkeydown={(e) => e.key === 'Enter' && selectPoint(point.id)}>
													<span class="text-sm">{point.name}</span>
													<div class="ml-auto">
														<button class="ml-1" title="Delete" onclick={(e) => { e.stopPropagation(); removeFrom('points', point.id); }}>
															<span class="material-symbols-rounded notranslate">delete</span>
														</button>
													</div>
												</div>
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>

						<!-- Seams -->
						<div class="flex flex-col w-full">
							<div role="button" tabindex="0" class="flex items-center h-8 cursor-pointer select-none"
								onclick={() => toggleGroup('seams')}
								onkeydown={(e) => e.key === 'Enter' && toggleGroup('seams')}>
								<button class="mr-2" title={collapsed.seams ? 'Expand' : 'Collapse'}>
									<span class="material-symbols-rounded notranslate">{collapsed.seams ? 'add' : 'remove'}</span>
								</button>
								<span class="text-sm">Seams ({seams.length})</span>
							</div>
							{#if !collapsed.seams}
								<div class="ml-4">
									{#each seams as seam (seam.id)}
										<div role="listitem" draggable="true"
											class="select-none rounded-md px-2 py-1 transition-colors hover:bg-base-200 active:bg-base-300 flex items-center gap-2 cursor-[ns-resize]"
											class:bg-base-200={selectedKey === seam.id}
											ondragstart={() => rowDragStart('seams', seam.id)}
											ondragover={(e) => e.preventDefault()}
											ondrop={(e) => { e.preventDefault(); rowDrop('seams', seam.id); }}>
											<span class="material-symbols-rounded text-base-content/70 notranslate" title="Drag to reorder">drag_indicator</span>
											<div class="flex flex-col w-full">
												<div role="button" tabindex="0" class="flex items-center h-8 cursor-pointer select-none" title="Select"
													onclick={() => selectSeamRow(seam.id)}
													onkeydown={(e) => e.key === 'Enter' && selectSeamRow(seam.id)}>
													<span class="text-sm">{seamLabel(seam)}</span>
													<div class="ml-auto">
														<button class="ml-1" title="Delete" onclick={(e) => { e.stopPropagation(); removeFrom('seams', seam.id); }}>
															<span class="material-symbols-rounded notranslate">delete</span>
														</button>
													</div>
												</div>
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>

						<!-- Text -->
						<div class="flex flex-col w-full">
							<div role="button" tabindex="0" class="flex items-center h-8 cursor-pointer select-none"
								onclick={() => toggleGroup('texts')}
								onkeydown={(e) => e.key === 'Enter' && toggleGroup('texts')}>
								<button class="mr-2" title={collapsed.texts ? 'Expand' : 'Collapse'}>
									<span class="material-symbols-rounded notranslate">{collapsed.texts ? 'add' : 'remove'}</span>
								</button>
								<span class="text-sm">Text ({texts.length})</span>
							</div>
							{#if !collapsed.texts}
								<div class="ml-4">
									{#each texts as text (text.id)}
										<div role="listitem" draggable="true"
											class="select-none rounded-md px-2 py-1 transition-colors hover:bg-base-200 active:bg-base-300 flex items-center gap-2 cursor-[ns-resize]"
											class:bg-base-200={selectedKey === text.id}
											ondragstart={() => rowDragStart('texts', text.id)}
											ondragover={(e) => e.preventDefault()}
											ondrop={(e) => { e.preventDefault(); rowDrop('texts', text.id); }}>
											<span class="material-symbols-rounded text-base-content/70 notranslate" title="Drag to reorder">drag_indicator</span>
											<div class="flex flex-col w-full">
												<div role="button" tabindex="0" class="flex items-center h-8 cursor-pointer select-none" title="Select"
													onclick={() => selectOther(text.id)}
													onkeydown={(e) => e.key === 'Enter' && selectOther(text.id)}>
													<span class="text-sm">{textLabel(text)}</span>
													<div class="ml-auto">
														<button class="ml-1" title="Delete" onclick={(e) => { e.stopPropagation(); removeFrom('texts', text.id); }}>
															<span class="material-symbols-rounded notranslate">delete</span>
														</button>
													</div>
												</div>
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				</div>
			</div>
		{/if}
	</div>
{/if}
