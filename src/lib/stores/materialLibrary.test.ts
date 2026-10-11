import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { Pattern } from '@seamer/pattern-model';
import type { LibraryItem } from './materialLibrary';

const material = (JSON.parse(readFileSync(new URL('../../../static/templates/pencil-skirt.json', import.meta.url), 'utf8')) as Pattern).materials[0];
function libraryItem(index: number): LibraryItem {
  return { id: `fabric-${index}`, name: `Fabric ${index}`, version: 1, updatedAt: '2026-10-11T12:00:00Z', writeProtected: false, ownerUserId: null, material: structuredClone(material) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('fabric library durability', () => {
  it('preserves unreadable data in a backup before writing a new library', async () => {
    const entries = new Map([['seamer.materialLibrary.v1', '{broken']]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) });
    const library = await import('./materialLibrary');
    expect(get(library.materialLibrary)).toEqual([]);
    expect(entries.get('seamer.materialLibrary.v1.invalid-backup')).toBe('{broken');
    expect(get(library.libraryPersistenceError)).toContain('could not be read');
    const link = library.saveNewLibraryItem(material, '2026-10-11T12:00:00Z');
    expect(JSON.parse(entries.get('seamer.materialLibrary.v1')!)[0].id).toBe(link.libraryItemId);
    expect(entries.get('seamer.materialLibrary.v1.invalid-backup')).toBe('{broken');
  });
  it('leaves protected original data intact when storage cannot accept its backup', async () => {
    const setter = vi.fn(() => { throw new Error('Quota exceeded'); });
    vi.stubGlobal('localStorage', { getItem: () => '{broken', setItem: setter });
    const library = await import('./materialLibrary');
    expect(get(library.libraryPersistenceError)).toContain('original browser entry is protected');
    library.saveNewLibraryItem(material, '2026-10-11T12:00:00Z');
    expect(setter).toHaveBeenCalledTimes(1); // Only the backup was attempted, never the original entry.
    expect(get(library.materialLibrary)).toHaveLength(1);
    expect(get(library.libraryPersistenceError)).toContain('could not be saved');
  });
  it('rejects a valid catalog exceeding combined capacity without changing saved fabrics, including on reload', async () => {
    const original = [libraryItem(0)];
    const entries = new Map([['seamer.materialLibrary.v1', JSON.stringify(original)]]);
    const setter = vi.fn((key: string, value: string) => entries.set(key, value));
    vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: setter });
    const library = await import('./materialLibrary');
    const catalog = Array.from({ length: 500 }, (_, index) => libraryItem(index + 1));
    expect(() => library.importCatalogItems(catalog, 'Provider collection', '2026-10-11T13:00:00Z')).toThrow('limited to 500');
    expect(get(library.libraryPersistenceError)).toContain('import a smaller catalog');
    expect(get(library.materialLibrary)).toEqual(original);
    expect(setter).not.toHaveBeenCalled();
    expect(entries.get('seamer.materialLibrary.v1')).toBe(JSON.stringify(original));
    vi.resetModules();
    const reloaded = await import('./materialLibrary');
    expect(get(reloaded.materialLibrary)).toEqual(original);
    expect(get(reloaded.libraryPersistenceError)).toBeNull();
    expect(entries.has('seamer.materialLibrary.v1.invalid-backup')).toBe(false);
  });
  it('allows saving the final available fabric and preserves the full library after repeated over-capacity saves', async () => {
    const entries = new Map([['seamer.materialLibrary.v1', JSON.stringify(Array.from({ length: 499 }, (_, index) => libraryItem(index)))]]);
    const setter = vi.fn((key: string, value: string) => entries.set(key, value));
    vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: setter });
    const library = await import('./materialLibrary');
    const link = library.saveNewLibraryItem(material, '2026-10-11T13:00:00Z');
    expect(get(library.materialLibrary)).toHaveLength(500);
    const savedItem = library.getLibraryItem(link.libraryItemId);
    expect(savedItem?.material).toMatchObject({ id: material.id, weight: material.weight, thickness: material.thickness, frontTexture: material.frontTexture, backTexture: material.backTexture });
    expect(savedItem?.material).not.toHaveProperty('libraryItemId');
    const lastSaved = entries.get('seamer.materialLibrary.v1');
    for (let attempt = 0; attempt < 2; attempt++) expect(() => library.saveNewLibraryItem(material, '2026-10-11T14:00:00Z')).toThrow('limited to 500');
    expect(get(library.materialLibrary)).toHaveLength(500);
    expect(get(library.libraryPersistenceError)).toContain('limited to 500');
    expect(setter).toHaveBeenCalledTimes(1);
    expect(entries.get('seamer.materialLibrary.v1')).toBe(lastSaved);
    vi.resetModules();
    const reloaded = await import('./materialLibrary');
    expect(get(reloaded.materialLibrary)).toHaveLength(500);
    expect(reloaded.getLibraryItem(link.libraryItemId)).toEqual(savedItem);
    expect(get(reloaded.libraryPersistenceError)).toBeNull();
  });
});
