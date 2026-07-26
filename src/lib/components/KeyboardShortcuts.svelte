<script lang="ts">
	// Keyboard-shortcuts reference overlay. Toggle with the `?` key or the header button.
	let { open = $bindable(false) }: { open?: boolean } = $props();

	const groups: { title: string; items: { keys: string[]; label: string }[] }[] = [
		{
			title: 'General',
			items: [
				{ keys: ['Ctrl', 'Z'], label: 'Undo' },
				{ keys: ['Ctrl', 'Shift', 'Z'], label: 'Redo' },
				{ keys: ['Ctrl', 'S'], label: 'Save' },
				{ keys: ['Ctrl', 'D'], label: 'Duplicate selected piece' },
				{ keys: ['Delete'], label: 'Delete selection (cascades)' },
				{ keys: ['Ctrl', '0'], label: 'Fit pieces to view' },
				{ keys: ['Ctrl', '−'], label: 'Zoom out (Ctrl+= zooms in)' },
				{ keys: ['Ctrl', 'B'], label: 'Toggle property panel' },
				{ keys: ['Shift', 'V'], label: 'Open Sizes & Variables' },
				{ keys: ['Ctrl', 'Shift', 'L'], label: 'Toggle layers panel' },
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
				{ keys: ['Esc'], label: 'Cancel current operation' }
			]
		},
		{
			title: '3D',
			items: [{ keys: ['A'], label: 'Toggle arrange mode' }]
		}
	];
</script>

{#if open}
	<div
		class="fixed inset-0 z-[80] flex items-center justify-center bg-black/40"
		role="button"
		tabindex="-1"
		aria-label="Close shortcuts"
		onclick={() => (open = false)}
		onkeydown={(e) => e.key === 'Escape' && (open = false)}
	>
		<div
			class="bg-base-100 rounded-lg shadow-xl max-w-2xl w-[90vw] max-h-[80vh] overflow-y-auto p-5"
			role="dialog"
			aria-modal="true"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			<div class="flex items-center mb-4">
				<span class="material-symbols-rounded notranslate mr-2" aria-hidden="true">keyboard</span>
				<h2 class="font-bold text-lg">Keyboard shortcuts</h2>
				<button class="ml-auto btn btn-sm btn-ghost btn-square" aria-label="Close" onclick={() => (open = false)}>
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
		</div>
	</div>
{/if}
