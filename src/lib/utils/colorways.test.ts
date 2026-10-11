import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createEmptyPattern, createColorway, switchColorway, updateColorwayPiece,
  duplicateColorway, deleteColorway, renameColorway, colorwayProblems, removeColorwayPiece,
  type Pattern
} from '@seamer/pattern-model';
import { patternToSSP, sspToPattern } from './ssp';

function fixture(): Pattern {
  const source = JSON.parse(readFileSync(new URL('../../../static/templates/pencil-skirt.json', import.meta.url), 'utf8')) as Pattern;
  return {
    ...createEmptyPattern(),
    materials: source.materials.slice(0, 2).map((material, index) => ({ ...material, id: `fabric-${index}`, frontTexture: { ...material.frontTexture!, url: '', color: '#336699' } })),
    pieces: source.pieces.slice(0, 2).map((piece, index) => ({ ...piece, id: `piece-${index}`, materialId: 'fabric-0' })),
    points: source.points, paths: source.paths
  };
}
function setup() {
  let id = 0;
  return createColorway(fixture(), 'Summer', () => `variant-${++id}`);
}

const tint = (pattern: Pattern, color: string) => updateColorwayPiece(pattern, pattern.colorways!.activeId!, 'piece-0', { materialId: pattern.pieces[0].materialId, frontColor: color }).pattern;

describe('named colorways over shared pattern geometry', () => {
  it('preserves Original and captures live assignment edits before switching', () => {
    let pattern = setup();
    expect(pattern.colorways!.variants.map(variant => variant.name)).toEqual(['Original', 'Summer']);
    const original = pattern.colorways!.variants[0].id;
    const summer = pattern.colorways!.activeId!;
    pattern = { ...pattern, pieces: pattern.pieces.map(piece => piece.id === 'piece-0' ? { ...piece, materialId: 'fabric-1' } : piece) };
    const switched = switchColorway(pattern, original);
    expect(switched.errors).toEqual([]);
    expect(switched.pattern.pieces[0].materialId).toBe('fabric-0');
    expect(switched.pattern.colorways!.variants.find(variant => variant.id === summer)!.pieces['piece-0'].materialId).toBe('fabric-1');
    expect(switchColorway(switched.pattern, summer).pattern.pieces[0].materialId).toBe('fabric-1');
  });

  it('uses real material clones for separate front/back tint without changing geometry, checkpoint or source physics', () => {
    const before = setup();
    const originalFabric = structuredClone(before.materials[0]);
    const edited = updateColorwayPiece(before, before.colorways!.activeId!, 'piece-0', { materialId: 'fabric-0', frontColor: '#ff0000', backColor: '#00ff00' }).pattern;
    const material = edited.materials.find(material => material.id === edited.pieces[0].materialId)!;
    expect(material.frontTexture!.color).toBe('#ff0000');
    expect(material.backTexture!.color).toBe('#00ff00');
    expect(material.useSeparateBackSide).toBe(true);
    expect(material.stretchWarpValue).toBe(originalFabric.stretchWarpValue);
    expect(material.weight).toBe(originalFabric.weight);
    expect(edited.materials.find(material => material.id === 'fabric-0')).toEqual(originalFabric);
    expect(edited.points).toBe(before.points);
    expect(edited.paths).toBe(before.paths);
    expect(edited.pieces[0].mainPaths).toBe(before.pieces[0].mainPaths);
    expect(edited.pieces[0].settings3d).toBe(before.pieces[0].settings3d);
    expect(edited.pieces[1]).toMatchObject(before.pieces[1]);
    expect(edited.colorways!.generatedMaterialSources[material.id]).toBe('fabric-0');
  });

  it('bounds repeated tint copies and retains live physics edits on the actual copy', () => {
    let pattern = tint(setup(), '#ff0000');
    const copyId = pattern.pieces[0].materialId;
    const count = pattern.materials.length;
    pattern = { ...pattern, materials: pattern.materials.map(material => material.id === copyId ? { ...material, thickness: 1.75 } : material) };
    for (const color of ['#00ff00', '#0000ff', '#ffff00']) pattern = tint(pattern, color);
    expect(pattern.pieces[0].materialId).toBe(copyId);
    expect(pattern.materials).toHaveLength(count);
    expect(pattern.materials.find(material => material.id === copyId)!.thickness).toBe(1.75);
  });

  it('duplicates independently, renames, and keeps displayed fabrics when deleting the active colorway', () => {
    const pattern = tint(setup(), '#ff0000');
    const duplicated = duplicateColorway(pattern, pattern.colorways!.activeId!, () => 'copy');
    expect(duplicated.colorways!.variants.at(-1)!.pieces).not.toBe(duplicated.colorways!.variants[1].pieces);
    const renamed = renameColorway(duplicated, 'copy', 'Evening');
    expect(renamed.colorways!.variants.at(-1)!.name).toBe('Evening');
    const copyView = switchColorway(renamed, 'copy').pattern;
    const changedCopy = updateColorwayPiece(copyView, 'copy', 'piece-0', { materialId: copyView.pieces[0].materialId, frontColor: '#0000ff' }).pattern;
    const summerView = switchColorway(changedCopy, pattern.colorways!.activeId!).pattern;
    expect(summerView.materials.find(material => material.id === summerView.pieces[0].materialId)!.frontTexture!.color).toBe('#ff0000');
    const deleted = deleteColorway(summerView, summerView.colorways!.activeId!);
    expect(deleted.colorways!.activeId).toBeNull();
    expect(deleted.pieces).toBe(summerView.pieces);
    expect(deleted.colorways!.variants).toHaveLength(2);
  });

  it('blocks missing piece/fabric references without silently assigning a fallback and supports explicit repair', () => {
    const pattern = setup();
    const original = pattern.colorways!.variants[0];
    const invalid = { ...pattern, colorways: { ...pattern.colorways!, variants: pattern.colorways!.variants.map(variant => variant.id === original.id
      ? { ...variant, pieces: { ...variant.pieces, 'piece-0': { materialId: 'removed-fabric' }, obsolete: { materialId: 'fabric-0' } } } : variant) } };
    expect(colorwayProblems(invalid, invalid.colorways.variants[0])).toHaveLength(2);
    const blocked = switchColorway(invalid, original.id);
    expect(blocked.pattern).toBe(invalid);
    expect(blocked.errors).toHaveLength(2);
    const repairedPiece = updateColorwayPiece(invalid, original.id, 'piece-0', { materialId: 'fabric-1' }).pattern;
    const repaired = removeColorwayPiece(repairedPiece, original.id, 'obsolete');
    expect(switchColorway(repaired, original.id).errors).toEqual([]);
    expect(switchColorway(repaired, original.id).pattern.pieces[0].materialId).toBe('fabric-1');
  });

  it('round-trips colorways, lineage, effective colors and piece identities through JSON and native SSP', async () => {
    const pattern = tint(setup(), '#ab1234');
    const json = JSON.parse(JSON.stringify(pattern)) as Pattern;
    expect(json.colorways).toEqual(pattern.colorways);
    const restored = await sspToPattern(await patternToSSP(pattern));
    expect(restored.colorways).toEqual(pattern.colorways);
    expect(restored.pieces.map(piece => piece.id)).toEqual(pattern.pieces.map(piece => piece.id));
    expect(restored.materials.find(material => material.id === restored.pieces[0].materialId)!.frontTexture!.color).toBe('#ab1234');
    const originalView = switchColorway(restored, restored.colorways!.variants[0].id);
    expect(originalView.errors).toEqual([]);
    expect(originalView.pattern.pieces[0].materialId).toBe('fabric-0');
  });
});
