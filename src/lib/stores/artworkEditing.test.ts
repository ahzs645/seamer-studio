import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./pattern', async () => { const { writable } = await import('svelte/store'); return { selectedTool: writable('select') }; });
import { get } from 'svelte/store';
import { artworkEditing } from './artworkEditing';
import { selectedTool } from './pattern';
afterEach(()=>{artworkEditing.set(null);selectedTool.set('select');});
it('activating an artwork tool relinquishes drafting, and selecting a drafting tool relinquishes artwork',()=>{
  selectedTool.set('pen');artworkEditing.set({id:'print',mode:'translate'});
  expect(get(selectedTool)).toBe('select');expect(get(artworkEditing)).toEqual({id:'print',mode:'translate'});
  artworkEditing.update(value=>value?{...value,mode:'rotate'}:value);expect(get(artworkEditing)?.mode).toBe('rotate');
  selectedTool.set('pen');expect(get(artworkEditing)).toBeNull();expect(get(selectedTool)).toBe('pen');
  artworkEditing.set(null);expect(get(selectedTool)).toBe('pen');
});
