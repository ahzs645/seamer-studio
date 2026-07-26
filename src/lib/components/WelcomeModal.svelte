<script lang="ts">
	import { onMount } from 'svelte';

	// Lightweight first-visit welcome (a one-time intro, not a full element-targeted tour).
	// Persists a "seen" flag in localStorage so it only appears once.
	const STORAGE_KEY = 'seamer.welcomeSeen';
	const LEGACY_KEY = 'seamscape.welcomeSeen'; // pre-rebrand key — migrated on first load
	let { open = $bindable(false), onshowshortcuts = () => {}, onstarttour = () => {} }:
		{ open?: boolean; onshowshortcuts?: () => void; onstarttour?: () => void } = $props();

	onMount(() => {
		try {
			const legacy = localStorage.getItem(LEGACY_KEY);
			if (legacy && !localStorage.getItem(STORAGE_KEY)) {
				localStorage.setItem(STORAGE_KEY, legacy);
				localStorage.removeItem(LEGACY_KEY);
			}
			if (!localStorage.getItem(STORAGE_KEY)) open = true;
		} catch { /* storage unavailable — just don't auto-open */ }
	});

	function dismiss() {
		open = false;
		try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
	}

	const features: { icon: string; title: string; body: string }[] = [
		{ icon: 'draw', title: 'Draft in 2D', body: 'Use the pen, point, piece and seam tools on the left to draft your pattern.' },
		{ icon: 'view_in_ar', title: 'See it in 3D', body: 'Pieces drape on a parametric avatar — run the simulation from the 3D rail.' },
		{ icon: 'view_list', title: 'Object browser', body: 'Browse and manage every path, piece, point and seam from the toolbar.' },
		{ icon: 'file_export', title: 'Import / Export', body: 'Bring in DXF/SVG, or export SVG, DXF, PNG, CSV, OBJ — or print.' }
	];
</script>

{#if open}
	<div
		class="fixed inset-0 z-[85] flex items-center justify-center bg-black/40"
		role="button"
		tabindex="-1"
		aria-label="Dismiss welcome"
		onclick={dismiss}
		onkeydown={(e) => e.key === 'Escape' && dismiss()}
	>
		<div
			class="bg-base-100 rounded-lg shadow-xl max-w-lg w-[90vw] p-6"
			role="dialog"
			aria-modal="true"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			<h2 class="font-lexend font-semibold text-xl mb-1">Welcome to Pattern Studio</h2>
			<p class="text-sm opacity-70 mb-4">Design sewing patterns in 2D and see them drape in 3D.</p>
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
				{#each features as f}
					<div class="flex gap-3 items-start">
						<span class="material-symbols-rounded notranslate text-primary shrink-0" aria-hidden="true">{f.icon}</span>
						<div>
							<div class="font-medium text-sm">{f.title}</div>
							<div class="text-xs opacity-70">{f.body}</div>
						</div>
					</div>
				{/each}
			</div>
			<div class="flex items-center gap-2">
				<button class="btn btn-primary btn-sm" onclick={dismiss}>Get started</button>
				<button class="btn btn-ghost btn-sm" onclick={() => { dismiss(); onstarttour(); }}>
					<span class="material-symbols-rounded notranslate" style="font-size:18px" aria-hidden="true">tour</span>
					Take tour
				</button>
				<button class="btn btn-ghost btn-sm" onclick={() => { dismiss(); onshowshortcuts(); }}>
					<span class="material-symbols-rounded notranslate" style="font-size:18px" aria-hidden="true">keyboard</span>
					Keyboard shortcuts
				</button>
			</div>
		</div>
	</div>
{/if}
