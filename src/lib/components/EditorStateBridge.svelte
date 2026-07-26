<script lang="ts">
  import type { Editor } from '@atelier/core';
  import { editorState, type EditorState } from '@atelier/svelte';
  import type { Pattern } from '@seamer/pattern-model';

  interface Props {
    editor: Editor<Pattern>;
    onstate?: (state: EditorState<Pattern>) => void;
  }

  let { editor, onstate }: Props = $props();
  const state = editorState(editor);

  $effect(() => {
    onstate?.(state);
  });
</script>
