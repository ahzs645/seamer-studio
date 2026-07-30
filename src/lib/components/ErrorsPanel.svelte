<script lang="ts">
	import type { Editor } from '@atelier/core';
	import { editorState } from '@atelier/svelte';
	import { validatePattern, type Issue, type Pattern } from '@seamer/pattern-model';

	interface Props {
		currentPattern: Pattern;
		editor: Editor<Pattern>;
	}
	let { currentPattern, editor }: Props = $props();
	// svelte-ignore state_referenced_locally -- parent keys this component by Editor identity
	const editorView = editorState(editor);

	let open = $state(false);
	let issues = $derived<Issue[]>(validatePattern(currentPattern));
	let errorCount = $derived(issues.filter((i) => i.severity === 'error').length);
	let warnCount = $derived(issues.filter((i) => i.severity === 'warning').length);

	function focus(issue: Issue) {
		if (!issue.targetId) return;
		// best-effort: select whichever collection the id belongs to
		if (currentPattern.pieces.some((p) => p.id === issue.targetId)) {
			editor.setSelection(editorView.selection.replace('piece', [issue.targetId]).clear('path'));
		} else if (currentPattern.paths.some((p) => p.id === issue.targetId)) {
			editor.setSelection(editorView.selection.replace('path', [issue.targetId]).clear('piece'));
		}
	}
</script>

<div class="dropdown dropdown-end">
	<button
		type="button"
		tabindex="0"
		class="btn btn-ghost btn-xs gap-1"
		class:text-error={errorCount > 0}
		class:text-warning={errorCount === 0 && warnCount > 0}
		title="Pattern errors & warnings"
		onclick={() => (open = !open)}
	>
		<span class="material-symbols-rounded notranslate" style="font-size:18px" aria-hidden="true">
			{errorCount > 0 ? 'error' : warnCount > 0 ? 'warning' : 'check_circle'}
		</span>
		{#if errorCount + warnCount > 0}<span class="text-xs tabular-nums">{errorCount + warnCount}</span>{/if}
	</button>
	{#if open}
		<div class="dropdown-content z-[60] mt-1 w-80 max-h-96 overflow-y-auto bg-base-100 border border-base-300 rounded-box shadow-lg p-2">
			{#if issues.length === 0}
				<div class="flex items-center gap-2 text-sm text-success p-2">
					<span class="material-symbols-rounded notranslate" aria-hidden="true">check_circle</span>
					No problems detected
				</div>
			{:else}
				<div class="text-xs opacity-60 px-2 pb-1">{errorCount} error{errorCount === 1 ? '' : 's'}, {warnCount} warning{warnCount === 1 ? '' : 's'}</div>
				<ul class="space-y-1">
					{#each issues as issue}
						<li>
							<button
								class="w-full text-left flex items-start gap-2 p-2 rounded hover:bg-base-200 text-sm"
								onclick={() => { focus(issue); open = false; }}
							>
								<span
									class="material-symbols-rounded notranslate shrink-0"
									class:text-error={issue.severity === 'error'}
									class:text-warning={issue.severity === 'warning'}
									style="font-size:18px"
									aria-hidden="true"
								>{issue.severity === 'error' ? 'error' : 'warning'}</span>
								<span class="min-w-0">{issue.message}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
