<script lang="ts">
  import { simulationStage, SIMULATION_STAGE_LABELS, type SimulationStageInput } from '$lib/utils/simulationStage';
  let { status, arranging, savedPieces, held, source }: SimulationStageInput = $props();
  const stage = $derived(simulationStage({ status, arranging, savedPieces, held, source }));
</script>
<span class="badge badge-sm" role="status" aria-label="Simulation stage" data-testid="simulation-stage" data-stage={stage}>{SIMULATION_STAGE_LABELS[stage]}</span>
