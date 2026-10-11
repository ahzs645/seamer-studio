import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { type PieceArtwork } from '@seamer/pattern-model';
import { convertSimplePattern } from '$lib/utils/importSimplePattern';
import { PatternRenderer } from './scene3d';
import { createPieceTexture } from './pieceTexture';

vi.mock('./seamerLighting', () => ({ SeamerLighting: vi.fn() }));
vi.mock('./pieceTexture', () => ({
  createPieceTexture: vi.fn(() => new THREE.Texture()),
  pieceNeedsBake: vi.fn((bake: { artwork?: unknown[]; slot?: { url: string } }) => !!bake.artwork?.length || !!bake.slot?.url)
}));

function rig(mirrored = false) {
  const pattern = convertSimplePattern({ pieces: [{ name: 'Panel', sewLines: [], boundary: [[[0, 0], [100, 0]], [[100, 0], [0, 100]], [[0, 100], [0, 0]]] }] });
  const pieceId = pattern.pieces[0].id + (mirrored ? '#M' : '');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([.1, 1, .3, .2, 1.2, .4, .3, 1.1, .5], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(mirrored ? [0, 0, -100, 0, 0, 100] : [0, 0, 100, 0, 0, 100], 2));
  const material = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide });
  const normalMap = new THREE.Texture(), alphaMap = new THREE.Texture();
  material.normalMap = normalMap; material.alphaMap = alphaMap;
  const mesh = new THREE.Mesh(geometry, material);
  const entry = { pieceId, start: 0, count: 3, geometry, mesh, baseVisible: true, backMesh: undefined as THREE.Mesh | undefined };
  const prepared = { positions: new Float32Array([10, 20, 30]) };
  const sim = { positions: new Float32Array([1, 2, 3, 1]), dispose: vi.fn() };
  const runner = { stop: vi.fn(), dispose: vi.fn() };
  const renderer = Object.create(PatternRenderer.prototype) as PatternRenderer;
  Object.assign(renderer, { pattern, clothMeshes: [entry], clothBackMeshes: [], clothGroup: new THREE.Group(),
    renderer: { capabilities: { getMaxAnisotropy: () => 8 } }, disposed: false, artworkKey: '',
    prepared, sim, simRunner: runner, simulating: true, sourceSceneGeneration: 15, sourcePreparationRequestRevision: 4,
    invalidate: vi.fn() });
  const artwork: PieceArtwork = { id: 'print', pieceId: pattern.pieces[0].id, name: 'Print', dataUrl: 'data:image/png;base64,AAAA',
    mimeType: 'image/png', pixelWidth: 200, pixelHeight: 80, x: 40, y: 45, widthMm: 30, heightMm: 20, rotation: 12, opacity: 1 };
  return { renderer, pattern, entry, sim, runner, prepared, normalMap, alphaMap, artwork };
}

describe('artwork appearance updates', () => {
  it.each([false, true])('preserves live drape, mesh UVs, solver and checkpoint when editing/removing prints (mirrored=%s)', mirrored => {
    const state = rig(mirrored);
    const { renderer, pattern, entry, artwork } = state;
    const positions = Array.from(entry.geometry.getAttribute('position').array);
    const uvs = entry.geometry.getAttribute('uv');
    const saved = structuredClone(pattern.pieces[0].settings3d);
    renderer.setArtwork({ id: pattern.id, artwork: [artwork] });
    expect(entry.backMesh?.geometry).toBe(entry.geometry);
    expect((entry.mesh.material as THREE.Material).side).toBe(mirrored ? THREE.FrontSide : THREE.BackSide);
    expect((entry.backMesh?.material as THREE.Material).side).toBe(mirrored ? THREE.BackSide : THREE.FrontSide);
    expect(vi.mocked(createPieceTexture).mock.calls.at(-1)?.[0]).toMatchObject({ artwork: [artwork], mirrored });
    renderer.setArtwork({ id: pattern.id, artwork: [{ ...artwork, rotation: 91, widthMm: 60 }] });
    renderer.setArtwork({ id: pattern.id, artwork: [] });
    expect(entry.backMesh).toBeUndefined();
    expect((entry.mesh.material as THREE.Material).side).toBe(THREE.DoubleSide);
    expect(Array.from(entry.geometry.getAttribute('position').array)).toEqual(positions);
    expect(entry.geometry.getAttribute('uv')).toBe(uvs);
    expect(pattern.pieces[0].settings3d).toEqual(saved);
    expect((entry.mesh.material as THREE.MeshPhysicalMaterial).normalMap).toBe(state.normalMap);
    expect((entry.mesh.material as THREE.MeshPhysicalMaterial).alphaMap).toBe(state.alphaMap);
    expect((renderer as unknown as { prepared: unknown }).prepared).toBe(state.prepared);
    expect((renderer as unknown as { sim: unknown }).sim).toBe(state.sim);
    expect((renderer as unknown as { simulating: boolean }).simulating).toBe(true);
    expect(state.runner.stop).not.toHaveBeenCalled();
    expect(state.sim.dispose).not.toHaveBeenCalled();
  });

  it('rejects artwork changes during frozen diagnostic inspection', () => {
    const { renderer, pattern, artwork } = rig();
    Object.assign(renderer, { frozenPending: true });
    expect(() => renderer.setArtwork({ id: pattern.id, artwork: [artwork] })).toThrow('read-only frozen checkpoint');
  });
});
