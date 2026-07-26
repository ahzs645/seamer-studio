// "My templates" — user-saved pattern templates, persisted in localStorage (local-first, like the
// material library and machines). Edited via /flow/templates/edit/[[slug]].

import { writable, get } from 'svelte/store';
import type { Pattern } from '@seamer/pattern-model';

export interface CustomTemplate {
  slug: string;
  name: string;
  description: string;
  /** full pattern JSON used when instantiating the template */
  pattern: Pattern;
  updatedAt: string;
}

const KEY = 'seamer.customTemplates';

function load(): CustomTemplate[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as CustomTemplate[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export const customTemplates = writable<CustomTemplate[]>(load());

function persist(list: CustomTemplate[]) {
  customTemplates.set(list);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage full/unavailable */ }
}

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'template';
}

export function customTemplateBySlug(slug: string): CustomTemplate | undefined {
  return get(customTemplates).find((t) => t.slug === slug);
}

/** Insert or update (by slug). Returns the stored template. */
export function saveCustomTemplate(t: Omit<CustomTemplate, 'updatedAt'>): CustomTemplate {
  const stored: CustomTemplate = { ...t, updatedAt: new Date().toISOString() };
  const list = get(customTemplates).filter((x) => x.slug !== t.slug);
  persist([...list, stored].sort((a, b) => a.name.localeCompare(b.name)));
  return stored;
}

export function removeCustomTemplate(slug: string): void {
  persist(get(customTemplates).filter((x) => x.slug !== slug));
}
