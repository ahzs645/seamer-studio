// A local, browser-persisted material library — the offline-first stand-in for the original
// application's cloud material library (va.js). It mirrors the same surface: each library item
// carries a version + updatedAt + writeProtected/ownerUserId so a pattern's material can be linked
// to it, compared for staleness (local / synced / outdated) and saved/overwritten. When auth and a
// real backend are wired in, this store can be swapped for a network-backed implementation without
// touching the panels that consume it.

import { writable } from 'svelte/store';
import type { Material } from '@seamer/pattern-model';

const STORAGE_KEY = 'seamer.materialLibrary.v1';

export interface LibraryItem {
  id: string;
  name: string;
  version: number;
  updatedAt: string; // ISO-8601
  writeProtected: boolean;
  ownerUserId: string | null;
  /** the stored material body (without the library-link fields, which are pattern-local) */
  material: Omit<Material, 'libraryItemId' | 'libraryVersion' | 'libraryUpdatedAt'>;
}

function load(): LibraryItem[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LibraryItem[]) : [];
  } catch {
    return [];
  }
}

function persist(items: LibraryItem[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* quota / private mode — keep the in-memory store usable */
  }
}

/** Reactive list of library items (newest-updated first). */
export const materialLibrary = writable<LibraryItem[]>(load());

let current: LibraryItem[] = [];
materialLibrary.subscribe((v) => (current = v));

function commit(next: LibraryItem[]) {
  next.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  persist(next);
  materialLibrary.set(next);
}

/** Strip the pattern-local library-link fields, leaving the storable material body. */
function bodyOf(m: Material): LibraryItem['material'] {
  const { libraryItemId, libraryVersion, libraryUpdatedAt, ...rest } = m;
  return rest;
}

export function getLibraryItem(id: string | null | undefined): LibraryItem | null {
  if (!id) return null;
  return current.find((i) => i.id === id) ?? null;
}

/**
 * Save a pattern material into the library as a NEW item. Returns the link fields to write back
 * onto the pattern's material so it becomes "synced" to the new item. `now` is passed in because
 * the workflow/runtime forbids ambient Date in some contexts — callers stamp the time.
 */
export function saveNewLibraryItem(
  m: Material,
  now: string,
  opts: { writeProtected?: boolean; ownerUserId?: string | null } = {}
): { libraryItemId: string; libraryVersion: number; libraryUpdatedAt: string } {
  const id = `lib_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const item: LibraryItem = {
    id,
    name: m.name,
    version: 1,
    updatedAt: now,
    writeProtected: opts.writeProtected ?? false,
    ownerUserId: opts.ownerUserId ?? null,
    material: bodyOf(m)
  };
  commit([...current, item]);
  return { libraryItemId: id, libraryVersion: 1, libraryUpdatedAt: now };
}

/**
 * Overwrite the linked library item with the pattern material's current state, bumping the version.
 * No-op (returns null) if the item is missing or write-protected. Returns refreshed link fields.
 */
export function overwriteLibraryItem(
  m: Material,
  now: string
): { libraryItemId: string; libraryVersion: number; libraryUpdatedAt: string } | null {
  const item = getLibraryItem(m.libraryItemId);
  if (!item || item.writeProtected) return null;
  const version = item.version + 1;
  const next = current.map((i) =>
    i.id === item.id ? { ...i, name: m.name, version, updatedAt: now, material: bodyOf(m) } : i
  );
  commit(next);
  return { libraryItemId: item.id, libraryVersion: version, libraryUpdatedAt: now };
}

/** Build a fresh pattern material instance from a library item (linked + synced). */
export function instantiateFromLibrary(item: LibraryItem, newId: string): Material {
  return {
    ...item.material,
    id: newId,
    name: item.name,
    libraryItemId: item.id,
    libraryVersion: item.version,
    libraryUpdatedAt: item.updatedAt
  };
}

/** Pull the library item's latest body back onto a linked material (resolves an 'outdated' state). */
export function syncFromLibrary(m: Material): Material | null {
  const item = getLibraryItem(m.libraryItemId);
  if (!item) return null;
  return {
    ...item.material,
    id: m.id,
    name: item.name,
    libraryItemId: item.id,
    libraryVersion: item.version,
    libraryUpdatedAt: item.updatedAt
  };
}

export function deleteLibraryItem(id: string) {
  commit(current.filter((i) => i.id !== id));
}

export type LibraryStatus = 'local' | 'synced' | 'outdated' | 'missing';

/** Compare a linked material against its library item (mirrors va.js status logic). */
export function libraryStatus(m: Material): LibraryStatus {
  if (!m.libraryItemId) return 'local';
  const item = getLibraryItem(m.libraryItemId);
  if (!item) return 'missing';
  const localVer = m.libraryVersion ?? -1;
  if (item.version > localVer) return 'outdated';
  const localTime = m.libraryUpdatedAt ? new Date(m.libraryUpdatedAt).getTime() : 0;
  const libTime = new Date(item.updatedAt).getTime();
  if (libTime > localTime) return 'outdated';
  return 'synced';
}
