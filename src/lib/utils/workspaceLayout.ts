import type { WorkspaceDockNode, WorkspaceLayout, WorkspacePaneId } from '@seamer/pattern-model';

export type DockPlacement = 'before' | 'after' | 'above' | 'below';
export type WorkspacePreset = '2d' | '3d' | 'both' | 'specs' | 'all';
export const WORKSPACE_PANES: WorkspacePaneId[] = ['2d', '3d', 'specs'];
export const PANE_LABELS: Record<WorkspacePaneId, string> = { '2d': '2D', '3d': '3D', specs: 'Specs' };
export const MIN_WORKSPACE_RATIO = 0.25;
export const MAX_WORKSPACE_RATIO = 0.75;
const pane = (id: WorkspacePaneId): WorkspaceDockNode => ({ type: 'pane', pane: id });
const clampRatio = (ratio: number) => Math.min(MAX_WORKSPACE_RATIO, Math.max(MIN_WORKSPACE_RATIO, ratio));

export function nodePanes(node: WorkspaceDockNode): WorkspacePaneId[] {
  return node.type === 'pane' ? [node.pane] : [...nodePanes(node.first), ...nodePanes(node.second)];
}
export const layoutPanes = (layout: WorkspaceLayout): WorkspacePaneId[] => nodePanes(layout.root);
export function layoutViewMode(layout: WorkspaceLayout): WorkspacePreset {
  const panes = layoutPanes(layout);
  return panes.length === 1 ? panes[0] : panes.length === 3 ? 'all' : 'both';
}

export function workspacePreset(mode: WorkspacePreset): WorkspaceLayout {
  if (mode === '2d' || mode === '3d' || mode === 'specs') return { version: 1, root: pane(mode) };
  const design: WorkspaceDockNode = { type: 'split', id: 'design', direction: 'horizontal', ratio: 0.5,
    first: pane('2d'), second: pane('3d') };
  return { version: 1, root: mode === 'both' ? design : {
    type: 'split', id: 'design-specs', direction: 'horizontal', ratio: 0.7,
    first: design, second: pane('specs')
  } };
}

/** Reject malformed/duplicate panes rather than silently mounting multiple renderers. */
export function normalizeWorkspaceLayout(value: unknown): WorkspaceLayout | undefined {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) return;
  const panes = new Set<WorkspacePaneId>();
  const splits = new Set<string>();
  function parse(value: unknown, depth: number): WorkspaceDockNode | undefined {
    if (!value || typeof value !== 'object' || depth > 3) return;
    const candidate = value as Record<string, unknown>;
    if (candidate.type === 'pane') {
      const id = candidate.pane as WorkspacePaneId;
      if (!WORKSPACE_PANES.includes(id) || panes.has(id)) return;
      panes.add(id);
      return pane(id);
    }
    if (candidate.type !== 'split' || typeof candidate.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(candidate.id) || splits.has(candidate.id) ||
      (candidate.direction !== 'horizontal' && candidate.direction !== 'vertical') ||
      typeof candidate.ratio !== 'number' || !Number.isFinite(candidate.ratio)) return;
    splits.add(candidate.id);
    const first = parse(candidate.first, depth + 1), second = parse(candidate.second, depth + 1);
    if (!first || !second) return;
    return { type: 'split', id: candidate.id, direction: candidate.direction,
      ratio: clampRatio(candidate.ratio), first, second };
  }
  const root = parse((value as { root?: unknown }).root, 0);
  return root ? { version: 1, root } : undefined;
}

function removePane(node: WorkspaceDockNode, id: WorkspacePaneId): WorkspaceDockNode | undefined {
  if (node.type === 'pane') return node.pane === id ? undefined : node;
  const first = removePane(node.first, id), second = removePane(node.second, id);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}
function nextSplitId(root: WorkspaceDockNode): string {
  const ids = new Set<string>();
  function visit(node: WorkspaceDockNode) {
    if (node.type === 'split') { ids.add(node.id); visit(node.first); visit(node.second); }
  }
  visit(root);
  let index = 1;
  while (ids.has(`dock-${index}`)) index++;
  return `dock-${index}`;
}

/** Move one existing pane, or add a hidden pane, beside exactly one target leaf. */
export function dockPane(layout: WorkspaceLayout, source: WorkspacePaneId, target: WorkspacePaneId, placement: DockPlacement): WorkspaceLayout {
  if (source === target || !WORKSPACE_PANES.includes(source) || !layoutPanes(layout).includes(target) ||
    !['before', 'after', 'above', 'below'].includes(placement)) return layout;
  const remaining = removePane(layout.root, source);
  if (!remaining) return layout;
  const id = nextSplitId(remaining);
  const before = placement === 'before' || placement === 'above';
  function insert(node: WorkspaceDockNode): WorkspaceDockNode {
    if (node.type === 'pane') return node.pane !== target ? node : {
      type: 'split', id, direction: placement === 'above' || placement === 'below' ? 'vertical' : 'horizontal',
      ratio: 0.5, first: before ? pane(source) : node, second: before ? node : pane(source)
    };
    return { ...node, first: insert(node.first), second: insert(node.second) };
  }
  return { version: 1, root: insert(remaining) };
}

export function setPaneVisible(layout: WorkspaceLayout, id: WorkspacePaneId, visible: boolean): WorkspaceLayout {
  if (!WORKSPACE_PANES.includes(id)) return layout;
  const panes = layoutPanes(layout);
  if (visible === panes.includes(id) || (!visible && panes.length === 1)) return layout;
  if (!visible) return { version: 1, root: removePane(layout.root, id)! };
  if (id === 'specs' && panes.length === 2 && panes.includes('2d') && panes.includes('3d')) {
    return { version: 1, root: { type: 'split', id: nextSplitId(layout.root), direction: 'horizontal', ratio: 0.7,
      first: layout.root, second: pane(id) } };
  }
  return dockPane(layout, id, panes[panes.length - 1], 'after');
}

export function setSplitRatio(layout: WorkspaceLayout, id: string, ratio: number): WorkspaceLayout {
  if (!Number.isFinite(ratio)) return layout;
  const value = clampRatio(ratio);
  function update(node: WorkspaceDockNode): WorkspaceDockNode {
    if (node.type === 'pane') return node;
    if (node.id === id) return node.ratio === value ? node : { ...node, ratio: value };
    const first = update(node.first), second = update(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  }
  const root = update(layout.root);
  return root === layout.root ? layout : { version: 1, root };
}

export function arrangeWorkspacePanes(layout: WorkspaceLayout, direction: 'horizontal' | 'vertical'): WorkspaceLayout {
  const panes = layoutPanes(layout);
  if (panes.length < 2) return layout;
  const first: WorkspaceDockNode = panes.length === 2 ? pane(panes[0]) : {
    type: 'split', id: 'arrange-first', direction, ratio: 0.5, first: pane(panes[0]), second: pane(panes[1])
  };
  return { version: 1, root: { type: 'split', id: 'arrange-root', direction, ratio: panes.length === 3 ? 0.7 : 0.5,
    first, second: pane(panes[panes.length - 1]) } };
}

export function splitDefaultRatio(node: Extract<WorkspaceDockNode, { type: 'split' }>): number {
  const first = nodePanes(node.first);
  return first.length === 2 && first.includes('2d') && first.includes('3d') &&
    node.second.type === 'pane' && node.second.pane === 'specs' ? 0.7 : 0.5;
}
