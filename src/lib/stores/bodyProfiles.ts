// Named, reusable body profiles (the source's body-profile dropdown: Save as new / Rename /
// Delete). Persisted in localStorage like machines and the material library — local-first.

import { writable, get } from 'svelte/store';
import type { Body } from '@seamer/pattern-model';

export interface BodyProfile {
  id: string;
  name: string;
  body: Body;
  updatedAt: string;
}

const KEY = 'seamer.bodyProfiles';

function load(): BodyProfile[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as BodyProfile[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export const bodyProfiles = writable<BodyProfile[]>(load());

function persist(list: BodyProfile[]) {
  bodyProfiles.set(list);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

export function saveBodyProfile(name: string, body: Body): BodyProfile {
  const profile: BodyProfile = {
    id: crypto.randomUUID(),
    name: name.trim() || `Body ${get(bodyProfiles).length + 1}`,
    body: structuredClone(body),
    updatedAt: new Date().toISOString()
  };
  persist([...get(bodyProfiles), profile].sort((a, b) => a.name.localeCompare(b.name)));
  return profile;
}

export function updateBodyProfile(id: string, patch: Partial<Pick<BodyProfile, 'name' | 'body'>>): void {
  persist(get(bodyProfiles).map((p) => (p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p)));
}

export function removeBodyProfile(id: string): void {
  persist(get(bodyProfiles).filter((p) => p.id !== id));
}
