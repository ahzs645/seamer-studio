import type { Pattern } from '@seamer/pattern-model';
import { instantiateFromLibrary, type LibraryItem } from '$lib/stores/materialLibrary';

export type FabricSource = { kind: 'project'; id: string } | { kind: 'library'; item: LibraryItem };

/** Assignment and a library copy belong to one document update, so one undo restores both. */
export function applyFabric(
  pattern: Pattern,
  source: FabricSource,
  pieceIds: readonly string[],
  newId: () => string = () => crypto.randomUUID()
): { pattern: Pattern; count: number } {
  const targets = new Set(pieceIds);
  const count = pattern.pieces.filter(piece => targets.has(piece.id)).length;
  if (!count) return { pattern, count: 0 };
  const material = source.kind === 'project'
    ? pattern.materials.find(item => item.id === source.id)
    : structuredClone(instantiateFromLibrary(source.item, newId()));
  if (!material || (source.kind === 'library' && pattern.materials.some(item => item.id === material.id))) {
    return { pattern, count: 0 };
  }
  const changed = source.kind === 'library' || pattern.pieces.some(piece => targets.has(piece.id) && piece.materialId !== material.id);
  if (!changed) return { pattern, count: 0 };
  return {
    pattern: {
      ...pattern,
      materials: source.kind === 'library' ? [...pattern.materials, material] : pattern.materials,
      pieces: pattern.pieces.map(piece => targets.has(piece.id) ? { ...piece, materialId: material.id } : piece),
      hasChanged: true
    },
    count
  };
}

/** Removal keeps every piece assigned to an existing fabric, or explicitly unassigned if none remain. */
export function removeFabric(pattern: Pattern, id: string): Pattern {
  if (!pattern.materials.some(material => material.id === id)) return pattern;
  const materials = pattern.materials.filter(material => material.id !== id);
  return {
    ...pattern,
    materials,
    pieces: pattern.pieces.map(piece => piece.materialId === id ? { ...piece, materialId: materials[0]?.id ?? '' } : piece),
    hasChanged: true
  };
}
