<script lang="ts">
  import { STUDIO_TASKS, type StudioTask } from '$lib/utils/studioTasks';
  let { active = null, disabled = false, placement = 'bar', onselect }: { active?: StudioTask | null; disabled?: boolean; placement?: 'bar' | 'menu'; onselect: (task: StudioTask) => void } = $props();
</script>
<nav class="task-workflow" class:task-menu={placement === 'menu'} aria-label="Studio tasks" data-document-keyboard="true">
  {#each STUDIO_TASKS as task (task.id)}
    <button type="button" class="btn btn-ghost btn-xs" class:btn-active={active === task.id} aria-pressed={active === task.id}
      {disabled} title={task.description} onclick={() => onselect(task.id)} data-testid={`${placement === 'menu' ? 'task-menu' : 'task'}-${task.id}`}>
      <span class="material-symbols-rounded text-base" aria-hidden="true">{task.icon}</span>{task.label}
    </button>
  {/each}
</nav>
<style>
  .task-workflow { display:flex; gap:0.25rem; padding:0.25rem 0.5rem; flex-shrink:0; border-bottom:1px solid var(--fallback-b3, oklch(var(--b3))); overflow-x:auto; }
  .task-workflow button { flex-shrink:0; }
  .task-menu { display:none; }
  @media(max-width:1023px) { .task-workflow button { min-height:44px; } }
  @media (max-width:1023px) and (max-height:500px) and (orientation:landscape) {
    .task-workflow { display:none; }
    .task-menu { display:flex; flex-direction:column; width:100%; border:0; padding:0; }
    .task-menu button { justify-content:flex-start; min-width:44px; }
  }
</style>
