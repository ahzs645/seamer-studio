export interface ShortcutEvent { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
export const APP_SHORTCUTS = {
  undo: { key: 'z', mod: true }, redo: { key: 'z', mod: true, shift: true }, save: { key: 's', mod: true },
  palette: { key: 'k', mod: true }, properties: { key: 'b', mod: true }, layers: { key: 'l', mod: true, shift: true },
  variables: { key: 'v', shift: true }, help: { key: '?', shiftedCharacter: true }, duplicate: { key: 'd', mod: true },
  copy: { key: 'c', mod: true }, paste: { key: 'v', mod: true }, pasteCopy: { key: 'v', mod: true, shift: true },
  remove: { key: 'delete', alternatives: ['backspace'] }, fit: { key: '0', mod: true },
  zoomOut: { key: '-', mod: true }, zoomIn: { key: '=', alternatives: ['+'], mod: true, shiftedCharacter: true },
  nudgeLeft: { key: 'arrowleft' }, nudgeRight: { key: 'arrowright' }, nudgeUp: { key: 'arrowup' }, nudgeDown: { key: 'arrowdown' },
  nudgeLeftLarge: { key: 'arrowleft', shift: true }, nudgeRightLarge: { key: 'arrowright', shift: true }, nudgeUpLarge: { key: 'arrowup', shift: true }, nudgeDownLarge: { key: 'arrowdown', shift: true },
  rotateLeft: { key: '[' }, rotateRight: { key: ']' }, mirrorX: { key: 'm' }, mirrorY: { key: 'm', shift: true },
  finish: { key: 'enter' }, cancel: { key: 'escape' },
  sceneArrange: { key: 'a' }, sceneMove: { key: 'm' }, sceneSimulate: { key: ' ' }
} satisfies Record<string, { key: string; mod?: boolean; shift?: boolean; shiftedCharacter?: boolean; alternatives?: string[] }>;
export type ShortcutAction = keyof typeof APP_SHORTCUTS;
export function matchesShortcut(event: ShortcutEvent, action: ShortcutAction): boolean {
  const binding: { key: string; mod?: boolean; shift?: boolean; shiftedCharacter?: boolean; alternatives?: string[] } = APP_SHORTCUTS[action];
  return !event.altKey && (event.key.toLowerCase() === binding.key || Boolean(binding.alternatives?.includes(event.key.toLowerCase()))) &&
    Boolean(event.ctrlKey || event.metaKey) === Boolean(binding.mod) &&
    (Boolean(binding.shiftedCharacter) || event.shiftKey === Boolean(binding.shift));
}
export const DRAWING_SHORTCUTS: Record<string, string> = { select: 'V', pen: 'P', circle: 'C', 'arc-center': 'A', 'arc-3pt': 'Q', point: 'N', piece: 'T', internal: 'D', 'seam-single': 'S', 'seam-multi': 'Shift+S', text: 'I', image: 'G', trace: 'R', measure: 'M', pan: 'H' };
export function drawingShortcutTool(event: ShortcutEvent): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = `${event.shiftKey ? 'Shift+' : ''}${event.key.toUpperCase()}`;
  return Object.entries(DRAWING_SHORTCUTS).find(([, binding]) => binding === key)?.[0] ?? null;
}

function shortcutKeys(action: ShortcutAction): string[] {
  const binding: { key: string; mod?: boolean; shift?: boolean; alternatives?: string[] } = APP_SHORTCUTS[action];
  return [...(binding.mod ? ['Ctrl/Cmd'] : []), ...(binding.shift ? ['Shift'] : []), binding.key === ' ' ? 'Space' : [binding.key, ...(binding.alternatives ?? [])].join(' / ').toUpperCase()];
}
const item = (action: ShortcutAction, label: string) => ({ keys: shortcutKeys(action), label });
export const SHORTCUT_GROUPS = [
  { title: 'General', items: [item('undo', 'Undo'), item('redo', 'Redo'), item('save', 'Save'), item('palette', 'Command palette'), item('copy', 'Copy selection'), item('paste', 'Paste (click to place)'), item('pasteCopy', 'Paste as copy'), item('duplicate', 'Duplicate selected piece'), item('properties', 'Toggle property panel'), item('variables', 'Open Sizes & Variables'), item('layers', 'Toggle layers panel'), item('help', 'Toggle this help')] },
  { title: 'Tools (2D)', items: Object.entries(DRAWING_SHORTCUTS).map(([tool, binding]) => ({ keys: binding.split('+'), label: ({ select: 'Modify & select', pen: 'Pen tool', circle: 'Circle / ellipse', 'arc-center': 'Center arc', 'arc-3pt': 'Three-point arc', point: 'New point', piece: 'Create pattern piece', internal: 'Internal path (selected piece)', 'seam-single': 'Single seam', 'seam-multi': 'Multi seam', text: 'Insert text', image: 'Insert image', trace: 'Trace piece', measure: 'Measure (no selection)', pan: 'Pan' } as Record<string, string>)[tool] })) },
  { title: 'Selection and canvas (2D)', items: [item('remove', 'Delete selection (cascades)'), item('fit', 'Fit pieces to view'), item('zoomOut', 'Zoom out'), item('zoomIn', 'Zoom in'), ...(['nudgeLeft', 'nudgeRight', 'nudgeUp', 'nudgeDown'] as const).map(action => item(action, 'Nudge selection by 1 mm')), item('nudgeLeftLarge', 'Shift + arrows nudge by 10 mm'), item('rotateLeft', 'Rotate −15°'), item('rotateRight', 'Rotate +15°'), item('mirrorX', 'Mirror on X axis'), item('mirrorY', 'Mirror on Y axis'), item('finish', 'Finish path / advance multi seam'), item('cancel', 'Cancel current operation')] },
  { title: '3D (hover or focus the pane)', items: [item('sceneArrange', 'Toggle arrange mode'), item('sceneMove', 'Toggle move mode (arrange / no selection)'), item('sceneSimulate', 'Start / pause simulation')] }
];
