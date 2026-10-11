export type StudioTask = 'draft' | 'fit' | 'appearance' | 'production' | 'cutting';
export type StudioSidebar = 'layers' | 'body' | 'materials' | 'seams' | 'colorways' | 'artwork';
export interface StudioTaskPreset { id: StudioTask; label: string; icon: string; view: '2d' | 'both' | '3d' | 'specs'; sidebar: StudioSidebar; description: string }
export const STUDIO_TASKS: readonly StudioTaskPreset[] = [
  { id: 'draft', label: 'Draft', icon: 'draw', view: '2d', sidebar: 'layers', description: 'Edit geometry, measurements and linked pieces' },
  { id: 'fit', label: 'Fit', icon: 'accessibility_new', view: 'both', sidebar: 'body', description: 'Arrange, sew and inspect the simulated garment' },
  { id: 'appearance', label: 'Appearance', icon: 'palette', view: '3d', sidebar: 'materials', description: 'Choose fabrics, colorways and artwork' },
  { id: 'production', label: 'Production', icon: 'fact_check', view: 'specs', sidebar: 'seams', description: 'Measurements, assembly, BOM and Tech Pack' },
  { id: 'cutting', label: 'Cutting', icon: 'content_cut', view: '2d', sidebar: 'materials', description: 'Lay out the cutting marker and export cut files' }
];
export function studioTaskPreset(id: StudioTask): StudioTaskPreset { return STUDIO_TASKS.find(task => task.id === id)!; }
export function nextSidebarTab(ids: readonly string[], current: string, key: string): string | null {
  if (!ids.length) return null;
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  const delta = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  return delta ? ids[(Math.max(0, ids.indexOf(current)) + delta + ids.length) % ids.length] : null;
}
