import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEmptyPattern, type Pattern } from '@seamer/pattern-model';
import type { LibraryItem } from '$lib/stores/materialLibrary';
import { applyFabric, removeFabric } from './fabricApplication';

function fixture() {
  const example = JSON.parse(readFileSync(new URL('../../../static/templates/pencil-skirt.json', import.meta.url), 'utf8')) as Pattern;
  return {
    ...createEmptyPattern(),
    materials: example.materials.slice(0, 2).map((material, i) => ({ ...material, id: `fabric-${i}` })),
    pieces: example.pieces.slice(0, 2).map((piece, i) => ({ ...piece, id: `piece-${i}`, materialId: 'fabric-0' }))
  };
}

function libraryItem(pattern: Pattern): LibraryItem {
  const { libraryItemId: _id, libraryVersion: _version, libraryUpdatedAt: _updated, ...material } = pattern.materials[0];
  return { id: 'saved-fabric', name: 'Saved denim', version: 4, updatedAt: '2026-01-02T00:00:00Z', writeProtected: false, ownerUserId: null, material };
}

describe('explicit fabric application', () => {
  it('changes only valid selected pieces, with no automatic all-pieces fallback', () => {
    const pattern = fixture();
    const before = structuredClone(pattern);
    const result = applyFabric(pattern, { kind: 'project', id: 'fabric-1' }, ['piece-0', 'stale', 'piece-0']);
    expect(result.count).toBe(1);
    expect(result.pattern.pieces.map(piece => piece.materialId)).toEqual(['fabric-1', 'fabric-0']);
    expect(result.pattern.materials).toBe(pattern.materials);
    expect(pattern).toEqual(before);
    expect(applyFabric(pattern, { kind: 'project', id: 'fabric-1' }, []).pattern).toBe(pattern);
    expect(applyFabric(pattern, { kind: 'project', id: 'fabric-1' }, ['stale']).pattern).toBe(pattern);
  });

  it('copies the entire saved fabric once, preserves its version link and does not share texture objects', () => {
    const pattern = fixture();
    const item = libraryItem(pattern);
    const result = applyFabric(pattern, { kind: 'library', item }, ['piece-0', 'piece-1'], () => 'new-copy');
    const copy = result.pattern.materials.at(-1)!;
    expect(result.count).toBe(2);
    expect(result.pattern.materials).toHaveLength(pattern.materials.length + 1);
    expect(copy).toMatchObject({ id: 'new-copy', name: 'Saved denim', libraryItemId: item.id, libraryVersion: 4, libraryUpdatedAt: item.updatedAt });
    expect(copy.stretchWarpValue).toBe(item.material.stretchWarpValue);
    expect(copy.frontTexture).toEqual(item.material.frontTexture);
    expect(copy.frontTexture).not.toBe(item.material.frontTexture);
    expect(result.pattern.pieces.every(piece => piece.materialId === copy.id)).toBe(true);
    copy.frontTexture!.color = '#123456';
    expect(item.material.frontTexture!.color).not.toBe('#123456');
  });

  it('does not copy a library fabric when targets are empty or stale, and does not commit no-op/missing assignments', () => {
    const pattern = fixture();
    const item = libraryItem(pattern);
    const unusedId = () => { throw Error('Must not allocate for an empty target'); };
    expect(applyFabric(pattern, { kind: 'library', item }, [], unusedId).pattern).toBe(pattern);
    expect(applyFabric(pattern, { kind: 'library', item }, ['stale'], unusedId).pattern).toBe(pattern);
    expect(applyFabric(pattern, { kind: 'project', id: 'missing' }, ['piece-0']).pattern).toBe(pattern);
    expect(applyFabric(pattern, { kind: 'project', id: 'fabric-0' }, ['piece-0']).pattern).toBe(pattern);
  });

  it('removes used fabrics without leaving dangling assignments, including the last fabric', () => {
    const pattern = fixture();
    const result = removeFabric(pattern, 'fabric-0');
    expect(result.materials.map(material => material.id)).toEqual(['fabric-1']);
    expect(result.pieces.every(piece => piece.materialId === 'fabric-1')).toBe(true);
    expect(pattern.materials).toHaveLength(2);
    const empty = removeFabric(result, 'fabric-1');
    expect(empty.materials).toEqual([]);
    expect(empty.pieces.every(piece => piece.materialId === '')).toBe(true);
    expect(removeFabric(pattern, 'missing')).toBe(pattern);
  });
});
