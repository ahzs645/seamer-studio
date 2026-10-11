export type SimulationStage = 'source' | 'arranged' | 'running' | 'checkpoint' | 'held';
export interface SimulationStageInput { status: string; arranging: boolean; savedPieces: number; held: boolean; source: boolean }
export function simulationStage(input: SimulationStageInput): SimulationStage {
  if (input.status === 'simulating' || input.status === 'running') return 'running';
  if (input.arranging) return 'arranged';
  if (input.held && input.savedPieces > 0) return 'held';
  if (input.savedPieces > 0) return 'checkpoint';
  return input.source ? 'source' : 'arranged';
}
export const SIMULATION_STAGE_LABELS: Record<SimulationStage, string> = { source: 'Source geometry', arranged: 'Arranged pieces', running: 'Simulation running', checkpoint: 'Saved checkpoint', held: 'Held checkpoint' };
