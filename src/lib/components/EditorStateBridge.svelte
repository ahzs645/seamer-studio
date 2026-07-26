<script lang="ts">
  import type { Editor } from '@atelier/core';
  import { editorState, type EditorState } from '@atelier/svelte';
  import type { Pattern } from '@seamer/pattern-model';

  interface Props {
    editor: Editor<Pattern>;
    onstate?: (state: EditorState<Pattern>) => void;
  }

  let { editor, onstate }: Props = $props();

  // `editorState` installs an $effect bound to this component's lifetime, so it must be created
  // once at init and deliberately captures the initial `editor`. The studio holds a single
  // Editor for the app's lifetime, so this is correct today. If a different Editor instance is
  // ever passed, the parent must wrap this in {#key editor} to force a remount.
  // svelte-ignore state_referenced_locally
  const state = editorState(editor);

  $effect(() => {
    onstate?.(state);
  });
</script>
