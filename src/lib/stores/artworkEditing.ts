import { writable } from 'svelte/store';
import { selectedTool } from './pattern';
export type ArtworkGestureMode = 'translate' | 'rotate' | 'resize';
type ArtworkTool = { id: string; mode: ArtworkGestureMode } | null;
const selection = writable<ArtworkTool>(null);
let current: ArtworkTool = null;
selection.subscribe(value => { current = value; });
/** Appearance gestures own selection. Switching to a drafting tool relinquishes that ownership. */
selectedTool.subscribe(tool => { if (tool !== 'select' && current !== null) selection.set(null); });
function set(value: ArtworkTool) {
  if (value !== null) selectedTool.set('select');
  selection.set(value);
}
/** Transient tool selection; never included in the project document. */
export const artworkEditing = { subscribe: selection.subscribe, set, update: (change: (value: ArtworkTool) => ArtworkTool) => set(change(current)) };
