import type { Pattern } from '@seamer/pattern-model';
import { getLibraryItem } from '$lib/stores/materialLibrary';
import { applyFabric, type FabricSource } from './fabricApplication';

export const FABRIC_DRAG_TYPE = 'application/x-seamer-fabric';
export function startFabricDrag(event: DragEvent, kind: 'project' | 'library', id: string) {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(FABRIC_DRAG_TYPE, JSON.stringify({ kind, id }));
}
export function resolveFabricDrop(dataTransfer: Pick<DataTransfer, 'getData'>, pattern: Pattern): FabricSource | null {
  try {
    const raw = dataTransfer.getData(FABRIC_DRAG_TYPE);
    if (raw.length > 4096) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value.id !== 'string') return null;
    if (value.kind === 'project' && pattern.materials.some(material => material.id === value.id)) return { kind: 'project', id: value.id };
    if (value.kind === 'library') { const item = getLibraryItem(value.id); if (item) return { kind: 'library', item }; }
  } catch { /* Foreign and stale drags cannot modify the document. */ }
  return null;
}
export function applyFabricDrop(dataTransfer: Pick<DataTransfer, 'getData'>, pattern: Pattern, pieceIds: readonly string[]) {
  const source = resolveFabricDrop(dataTransfer, pattern);
  return source ? applyFabric(pattern, source, pieceIds) : { pattern, count: 0 };
}
