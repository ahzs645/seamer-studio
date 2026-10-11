<script lang="ts">
	import { containModalTab } from '$lib/utils/focus';
	// Keyboard-shortcuts reference overlay. Toggle with the `?` key or the header button.
	let { open = $bindable(false) }: { open?: boolean } = $props();

	const instanceId = $props.id();
	let dialog: HTMLDialogElement;
	let closeButton: HTMLButtonElement;
	let launcher: HTMLElement | null = null;

	$effect(() => {
		if (!open) return;
		launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialog.showModal();
		closeButton.focus();
		return () => {
			if (dialog.open) dialog.close();
			if (launcher?.isConnected) launcher.focus({ preventScroll: true });
		};
	});

	const groups: { title: string; items: { keys: string[]; label: string }[] }[] = [
		{
			title: 'General',
			items: [
				{ keys: ['Ctrl/Cmd', 'Z'], label: 'Undo' },
				{ keys: ['Ctrl/Cmd', 'Shift', 'Z'], label: 'Redo' },
				{ keys: ['Ctrl/Cmd', 'S'], label: 'Save' },
				{ keys: ['Ctrl/Cmd', 'K'], label: 'Command palette' },
				{ keys: ['Ctrl/Cmd', 'C'], label: 'Copy selection' },
				{ keys: ['Ctrl/Cmd', 'V'], label: 'Paste (click to place)' },
				{ keys: ['Ctrl/Cmd', 'Shift', 'V'], label: 'Paste as copy' },
				{ keys: ['Ctrl/Cmd', 'D'], label: 'Duplicate selected piece' },
				{ keys: ['Delete / Backspace'], label: 'Delete selection (cascades)' },
				{ keys: ['Ctrl/Cmd', '0'], label: 'Fit pieces to view' },
				{ keys: ['Ctrl/Cmd', '−'], label: 'Zoom out' },
				{ keys: ['Ctrl/Cmd', '= / +'], label: 'Zoom in' },
				{ keys: ['Ctrl/Cmd', 'B'], label: 'Toggle property panel' },
				{ keys: ['Shift', 'V'], label: 'Open Sizes & Variables' },
				{ keys: ['Ctrl/Cmd', 'Shift', 'L'], label: 'Toggle layers panel' },
				{ keys: ['?'], label: 'Toggle this help' }
			]
		},
		{
			title: 'Tools (2D)',
			items: [
				{ keys: ['V'], label: 'Modify & select' },
				{ keys: ['P'], label: 'Pen tool' },
				{ keys: ['N'], label: 'New point' },
				{ keys: ['T'], label: 'Create pattern piece' },
				{ keys: ['S'], label: 'Single seam' },
				{ keys: ['Shift', 'S'], label: 'Multi seam' },
				{ keys: ['I'], label: 'Insert text' },
				{ keys: ['C'], label: 'Circle / ellipse' },
				{ keys: ['A'], label: 'Center arc' },
				{ keys: ['Q'], label: 'Three-point arc' },
				{ keys: ['D'], label: 'Internal path (selected piece)' },
				{ keys: ['G'], label: 'Insert image' },
				{ keys: ['R'], label: 'Trace piece' },
				{ keys: ['M'], label: 'Measure (no selection)' },
				{ keys: ['Enter'], label: 'Finish path / advance multi seam' },
				{ keys: ['Esc'], label: 'Cancel current operation' }
			]
		},
		{
			title: 'Selection (2D)',
			items: [
				{ keys: ['↑', '↓', '←', '→'], label: 'Nudge selection by 1' },
				{ keys: ['Shift', 'Arrow'], label: 'Nudge selection by 10' },
				{ keys: ['[', ']'], label: 'Rotate −15° / +15°' },
				{ keys: ['M'], label: 'Mirror on X axis' },
				{ keys: ['Shift', 'M'], label: 'Mirror on Y axis' }
			]
		},
		{
			title: '3D (hover or focus the pane)',
			items: [
				{ keys: ['A'], label: 'Toggle arrange mode' },
				{ keys: ['M'], label: 'Toggle move mode (arrange / no selection)' },
				{ keys: ['Space'], label: 'Start / pause simulation' }
			]
		}
	];
</script>

<dialog
	bind:this={dialog}
	class="bg-base-100 text-base-content rounded-lg shadow-xl w-[90vw] max-w-3xl max-h-[80dvh] overflow-y-auto p-5 backdrop:bg-black/40"
	aria-labelledby={`${instanceId}-title`}
	oncancel={(event) => { event.preventDefault(); open = false; }}
	onkeydown={(event) => {
		event.stopPropagation();
		if (event.key === 'Escape') { event.preventDefault(); open = false; }
		else containModalTab(event, dialog);
	}}
	onclick={(event) => {
		if (event.target !== dialog) return;
		const rect = dialog.getBoundingClientRect();
		if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) open = false;
	}}
>
			<div class="flex items-center mb-4">
				<span class="material-symbols-rounded notranslate mr-2" aria-hidden="true">keyboard</span>
				<h2 id={`${instanceId}-title`} class="font-bold text-lg">Keyboard shortcuts</h2>
				<button bind:this={closeButton} class="ml-auto btn btn-sm btn-ghost btn-square" aria-label="Close" onclick={() => (open = false)}>
					<span class="material-symbols-rounded notranslate" aria-hidden="true">close</span>
				</button>
			</div>
			<div class="grid grid-cols-1 md:grid-cols-3 gap-5">
				{#each groups as group}
					<div>
						<h3 class="font-semibold text-sm mb-2 opacity-70">{group.title}</h3>
						<ul class="space-y-1.5">
							{#each group.items as item}
								<li class="flex items-center justify-between gap-2 text-sm">
									<span class="opacity-80">{item.label}</span>
									<span class="flex gap-1 shrink-0">
										{#each item.keys as k}<kbd class="kbd kbd-sm">{k}</kbd>{/each}
									</span>
								</li>
							{/each}
						</ul>
					</div>
				{/each}
			</div>
</dialog>
