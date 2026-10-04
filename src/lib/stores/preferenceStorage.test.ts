import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { Body, Material, Pattern } from '@seamer/pattern-model';

let originalStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.resetModules();
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => { throw new DOMException('Storage access blocked', 'SecurityError'); }
  });
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

it('loads and edits the material library in memory when the localStorage getter throws', async () => {
  const library = await import('./materialLibrary');
  expect(get(library.materialLibrary)).toEqual([]);
  const link = library.saveNewLibraryItem({ id: 'fabric', name: 'Cotton' } as Material, '2026-10-02');
  expect(library.getLibraryItem(link.libraryItemId)?.name).toBe('Cotton');
  library.deleteLibraryItem(link.libraryItemId);
  expect(get(library.materialLibrary)).toEqual([]);
});

it('loads and edits body profiles in memory when the localStorage getter throws', async () => {
  const profiles = await import('./bodyProfiles');
  expect(get(profiles.bodyProfiles)).toEqual([]);
  const profile = profiles.saveBodyProfile('My body', {} as Body);
  profiles.updateBodyProfile(profile.id, { name: 'Renamed' });
  expect(get(profiles.bodyProfiles)[0].name).toBe('Renamed');
  profiles.removeBodyProfile(profile.id);
  expect(get(profiles.bodyProfiles)).toEqual([]);
});

it('loads and edits custom templates in memory when the localStorage getter throws', async () => {
  const templates = await import('./customTemplates');
  expect(get(templates.customTemplates)).toEqual([]);
  templates.saveCustomTemplate({ slug: 'my-template', name: 'My template', description: '', pattern: { id: 'pattern' } as Pattern });
  expect(templates.customTemplateBySlug('my-template')?.name).toBe('My template');
  templates.removeCustomTemplate('my-template');
  expect(get(templates.customTemplates)).toEqual([]);
});
