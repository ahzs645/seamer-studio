import { describe, expect, it } from 'vitest';
import type { WorkspaceDockNode } from '@seamer/pattern-model';
import {
  workspacePreset, normalizeWorkspaceLayout, layoutPanes, layoutViewMode,
  dockPane, setPaneVisible, setSplitRatio
} from './workspaceLayout';

describe('document workspace layout', () => {
  it('rejects duplicate panes/split IDs and unsupported data, while bounding imported sizes', () => {
    const valid = workspacePreset('all');
    expect(normalizeWorkspaceLayout(valid)).toEqual(valid);
    const duplicatePane = structuredClone(valid);
    if (duplicatePane.root.type === 'split') duplicatePane.root.second = { type: 'pane', pane: '2d' };
    expect(normalizeWorkspaceLayout(duplicatePane)).toBeUndefined();
    const duplicateSplit = structuredClone(valid);
    if (duplicateSplit.root.type === 'split' && duplicateSplit.root.first.type === 'split') duplicateSplit.root.first.id = duplicateSplit.root.id;
    expect(normalizeWorkspaceLayout(duplicateSplit)).toBeUndefined();
    for (const bad of [
      { version: 2, root: valid.root },
      { version: 1, root: { type: 'pane', pane: 'chat' } },
      { version: 1, root: { ...valid.root, ratio: NaN } },
      { version: 1, root: { ...valid.root, id: 'unsafe id' } },
      { version: 1, root: { ...valid.root, direction: 'diagonal' } }
    ]) expect(normalizeWorkspaceLayout(bad)).toBeUndefined();
    const bounded = normalizeWorkspaceLayout({ version: 1, root: { ...valid.root, ratio: -10 } });
    expect(bounded?.root).toMatchObject({ ratio: 0.25 });
  });

  it('moves a pane into a genuinely nested split without duplicating it or altering unrelated ratios', () => {
    const original = setSplitRatio(workspacePreset('all'), 'design-specs', 0.65);
    const nested = dockPane(original, 'specs', '2d', 'below');
    expect(layoutPanes(nested)).toEqual(['2d', 'specs', '3d']);
    expect(nested.root).toMatchObject({ type: 'split', id: 'design', direction: 'horizontal', ratio: 0.5,
      first: { type: 'split', direction: 'vertical', first: { pane: '2d' }, second: { pane: 'specs' } }, second: { pane: '3d' } });
    const moved = dockPane(nested, '2d', '3d', 'after');
    expect(layoutPanes(moved)).toEqual(['specs', '3d', '2d']);
    expect(new Set(layoutPanes(moved)).size).toBe(3);
    expect(normalizeWorkspaceLayout(moved)).toEqual(moved);
    expect(original).toEqual(setSplitRatio(workspacePreset('all'), 'design-specs', 0.65));
    expect(dockPane(original, '2d', '2d', 'after')).toBe(original);
  });

  it('collapses empty branches when hiding panes and refuses to hide the final pane', () => {
    const hidden = setPaneVisible(workspacePreset('all'), '3d', false);
    expect(layoutPanes(hidden)).toEqual(['2d', 'specs']);
    expect(hidden.root).toMatchObject({ type: 'split', first: { pane: '2d' }, second: { pane: 'specs' }, ratio: 0.7 });
    const single = setPaneVisible(hidden, '2d', false);
    expect(single.root).toEqual({ type: 'pane', pane: 'specs' });
    expect(setPaneVisible(single, 'specs', false)).toBe(single);
    const restored = setPaneVisible(single, '2d', true);
    expect(layoutPanes(restored)).toEqual(['specs', '2d']);
    expect(layoutViewMode(restored)).toBe('both');
    expect(layoutViewMode(single)).toBe('specs');
  });

  it('resizes exactly one split independently and preserves immutable history snapshots', () => {
    const original = workspacePreset('all');
    const resized = setSplitRatio(original, 'design', 0.6);
    expect(resized.root).toMatchObject({ ratio: 0.7, first: { ratio: 0.6 } });
    expect(original.root).toMatchObject({ ratio: 0.7, first: { ratio: 0.5 } });
    expect(setSplitRatio(resized, 'missing', 0.6)).toBe(resized);
    expect(setSplitRatio(resized, 'design', NaN)).toBe(resized);
    expect(setSplitRatio(resized, 'design', 2).root).toMatchObject({ first: { ratio: 0.75 } });
    const collectIds = (node: WorkspaceDockNode): string[] => node.type === 'pane' ? [] : [node.id, ...collectIds(node.first), ...collectIds(node.second)];
    const moved = dockPane(resized, 'specs', '2d', 'above');
    expect(new Set(collectIds(moved.root)).size).toBe(collectIds(moved.root).length);
  });
});
