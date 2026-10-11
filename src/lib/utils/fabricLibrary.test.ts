import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Pattern } from '@seamer/pattern-model';
import type { LibraryItem } from '$lib/stores/materialLibrary';
import { FABRIC_TARGETS, fetchFabricCatalog, parseFabricCatalog, recommendFabrics } from './fabricLibrary';
import { applyFabricDrop, FABRIC_DRAG_TYPE, resolveFabricDrop } from './fabricDrag';

const pattern = JSON.parse(readFileSync(new URL('../../../static/templates/pencil-skirt.json', import.meta.url), 'utf8')) as Pattern;
function item(): LibraryItem {
  return { id: 'catalog-a', name: 'Catalog cotton', version: 1, updatedAt: '2026-10-11T12:00:00Z', writeProtected: false, ownerUserId: null, material: structuredClone(pattern.materials[0]) };
}

describe('validated fabric catalog and recommendations', () => {
  it('accepts complete material metadata and clones texture bodies', () => {
    const source = item();
    const result = parseFabricCatalog({ version: 1, materials: [source] });
    expect(result[0]).toEqual(source);
    expect(result[0].material.frontTexture).not.toBe(source.material.frontTexture);
  });
  it('rejects malformed physics, duplicate identities, unsafe texture URLs and organization metadata', () => {
    const source = item();
    expect(() => parseFabricCatalog({ version: 1, materials: [source, source] })).toThrow();
    for (const material of [{ ...source.material, weight: null }, { ...source.material, bendValue: 101 }, { ...source.material, thickness: -1 }, { ...source.material, frontTexture: { ...source.material.frontTexture, url: 'javascript:alert(1)' } }]) {
      expect(() => parseFabricCatalog({ version: 1, materials: [{ ...source, material }] })).toThrow();
    }
    expect(() => parseFabricCatalog({ version: 1, materials: [{ ...source, tags: ['valid', 5] }] })).toThrow();
  });
  it('ranks physics distance with explicit criteria and ignores incomplete records', () => {
    const a = item(), b = { ...item(), id: 'other', material: { ...item().material, weight: 120, thickness: 0.4, stretchWarpValue: 8, stretchWeftValue: 10, bendValue: 22 } };
    const missing = { ...item(), id: 'missing', material: { ...item().material, weight: NaN } };
    const ranked = recommendFabrics([a, missing, b], FABRIC_TARGETS['Woven shirt']);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].item.id).toBe('other');
    expect(ranked[0].distance).toBe(0);
    expect(ranked[0].differences).toHaveLength(5);
  });
  it('fetches with no credentials and reports HTTP/provider/data failures', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 1, materials: [item()] }), { status: 200 }));
    const fetched = await fetchFabricCatalog('https://catalog.example/fabrics.json', fetcher);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].material.frontTexture?.url).toMatch(/^https:\/\/catalog.example\//);
    expect(fetcher.mock.calls[0][1].credentials).toBe('omit');
    await expect(fetchFabricCatalog('https://person:secret@catalog.example/', fetcher)).rejects.toThrow('credentials');
    await expect(fetchFabricCatalog('https://catalog.example/', vi.fn().mockResolvedValue(new Response('', { status: 503 })))).rejects.toThrow('503');
    await expect(fetchFabricCatalog('https://catalog.example/', vi.fn().mockResolvedValue(new Response('{')))).rejects.toThrow();
  });
  it('resolves all relative texture assets against the final redirected catalog origin', async () => {
    const source = item();
    const texture = source.material.frontTexture!;
    texture.url = '/swatches/cotton.png';
    texture.normalUrl = '/swatches/cotton-normal.png';
    texture.opacityUrl = '/swatches/cotton-opacity.png';
    source.material.backTexture = { ...texture, url: '/swatches/cotton-back.png' };
    const response = new Response(JSON.stringify({ version: 1, materials: [source] }));
    Object.defineProperty(response, 'url', { value: 'https://provider.example/catalog/fabrics.json' });
    const result = await fetchFabricCatalog('https://redirect.example/fabrics', vi.fn().mockResolvedValue(response));
    expect(result[0].material.frontTexture).toMatchObject({ url: 'https://provider.example/swatches/cotton.png', normalUrl: 'https://provider.example/swatches/cotton-normal.png', opacityUrl: 'https://provider.example/swatches/cotton-opacity.png' });
    expect(result[0].material.backTexture?.url).toBe('https://provider.example/swatches/cotton-back.png');
    expect(texture.url).toBe('/swatches/cotton.png');
  });
  it('rejects unsafe final response protocols and embedded credentials before admitting assets', async () => {
    for (const url of ['file:///tmp/fabrics.json', 'data:application/json,{}', 'https://person:secret@provider.example/fabrics.json']) {
      const response = new Response(JSON.stringify({ version: 1, materials: [item()] }));
      Object.defineProperty(response, 'url', { value: url });
      await expect(fetchFabricCatalog('https://catalog.example/', vi.fn().mockResolvedValue(response))).rejects.toThrow('public HTTP or HTTPS');
      expect(response.bodyUsed).toBe(false);
    }
  });
});

describe('fabric drag admission', () => {
  it('uses live project IDs, applies one piece and preserves all geometry', () => {
    const data = { getData: (type: string) => type === FABRIC_DRAG_TYPE ? JSON.stringify({ kind: 'project', id: pattern.materials[0].id }) : '' };
    const target = { ...pattern, pieces: pattern.pieces.map(piece => ({ ...piece, materialId: '' })) };
    const result = applyFabricDrop(data, target, [target.pieces[0].id]);
    expect(result.count).toBe(1);
    expect(result.pattern.pieces[0].materialId).toBe(pattern.materials[0].id);
    expect(result.pattern.pieces[1].materialId).toBe('');
    expect(result.pattern.points).toBe(target.points);
    expect(result.pattern.paths).toBe(target.paths);
  });
  it('refuses foreign, malformed, stale and embedded fabric payloads', () => {
    for (const payload of ['', '{', JSON.stringify({ kind: 'project', id: 'missing' }), JSON.stringify({ kind: 'library', id: 'missing', item: item() }), JSON.stringify({ kind: 'remote', id: pattern.materials[0].id })]) {
      expect(resolveFabricDrop({ getData: () => payload }, pattern)).toBeNull();
    }
  });
});
