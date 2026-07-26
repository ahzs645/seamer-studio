// Cutting-machine registry — the local-first equivalent of the production app's cutting-room
// machine list. Machines persist to localStorage ('seamer.machines'); each one describes a bed
// (width × length, safety margin) and the cut-file format its controller accepts. The Cutting Room
// modal nests at a machine's usable bed width and generates per-machine cut files (see
// utils/cutfile.ts) — no network services involved.

import { persisted } from '$lib/stores/pattern';

export type CutFileFormat = 'hpgl' | 'cut' | 'svg';

export interface CuttingMachine {
  id: string;
  name: string;
  format: CutFileFormat;
  bedWidthMm: number;
  bedLengthMm: number;
  /** safety margin kept clear on every bed edge (mm) */
  marginMm: number;
  /** cutting speed hint (cm/s) — emitted as an HPGL VS command when set */
  speed?: number;
  /** pull slit notches this far inward along the edge (mm) so the knife doesn't nick the corner */
  slitNotchOffsetMm?: number;
  /** raster export resolution for camera/projection workflows (px per mm) */
  finalPixelsPerMm?: number;
  notes?: string;
}

const uid = () => `machine_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;

/** Sensible starter machines, used when nothing is persisted yet. */
export const DEFAULT_MACHINES: CuttingMachine[] = [
  { id: 'machine_hpgl_1400', name: 'HPGL plotter 1400mm', format: 'hpgl', bedWidthMm: 1400, bedLengthMm: 2500, marginMm: 10, speed: 40 },
  { id: 'machine_cut_1600', name: 'Generic CUT cutter 1600mm', format: 'cut', bedWidthMm: 1600, bedLengthMm: 3000, marginMm: 15 }
];

export const machines = persisted<CuttingMachine[]>('seamer.machines', DEFAULT_MACHINES);
/** Last machine chosen in the Cutting Room (persists across sessions). */
export const selectedMachineId = persisted<string>('seamer.selectedMachineId', DEFAULT_MACHINES[0].id);

export function createMachine(partial: Partial<CuttingMachine> = {}): CuttingMachine {
  return { id: uid(), name: 'New machine', format: 'hpgl', bedWidthMm: 1400, bedLengthMm: 2500, marginMm: 10, ...partial };
}

/** Append a machine to the registry and return it. */
export function addMachine(partial: Partial<CuttingMachine> = {}): CuttingMachine {
  const m = createMachine(partial);
  machines.update((list) => [...list, m]);
  return m;
}

/** Patch a machine by id (the id itself cannot be changed). */
export function updateMachine(id: string, patch: Partial<Omit<CuttingMachine, 'id'>>): void {
  machines.update((list) => list.map((m) => (m.id === id ? { ...m, ...patch, id } : m)));
}

export function removeMachine(id: string): void {
  machines.update((list) => list.filter((m) => m.id !== id));
}
