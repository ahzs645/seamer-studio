import { browser } from '$app/environment';
import type { Pattern } from '@seamer/pattern-model';

const DB_NAME = 'seamer-patterns';
const STORE_NAME = 'patterns';
const HISTORY_STORE = 'history';
const VERSIONS_STORE = 'versions';
const DB_VERSION = 3;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!browser) { reject('Not in browser'); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        db.createObjectStore(HISTORY_STORE, { keyPath: 'patternId' });
      }
      if (!db.objectStoreNames.contains(VERSIONS_STORE)) {
        const vs = db.createObjectStore(VERSIONS_STORE, { keyPath: 'id' });
        vs.createIndex('patternId', 'patternId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** A persisted undo/redo history record for one pattern (whole-pattern snapshots + labels). */
export interface HistoryRecord {
  patternId: string;
  undo: { pattern: Pattern; label: string }[];
  redo: { pattern: Pattern; label: string }[];
  savedAt: string;
}

export async function saveHistory(rec: Omit<HistoryRecord, 'savedAt'>): Promise<void> {
  const db = await openDB();
  // JSON round-trip strips Svelte $state proxies that IndexedDB's structured clone rejects.
  const plain = JSON.parse(JSON.stringify({ ...rec, savedAt: new Date().toISOString() }));
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, 'readwrite');
    tx.objectStore(HISTORY_STORE).put(plain);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadHistory(patternId: string): Promise<HistoryRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(HISTORY_STORE, 'readonly').objectStore(HISTORY_STORE).get(patternId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteHistory(patternId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, 'readwrite');
    tx.objectStore(HISTORY_STORE).delete(patternId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function savePattern(pattern: Pattern): Promise<void> {
  const db = await openDB();
  // Round-trip to a plain object: IndexedDB's structured clone can't serialize Svelte $state
  // proxies (throws DataCloneError), and JSON strips them while keeping all pattern data.
  const plain = JSON.parse(JSON.stringify({ ...pattern, updatedAt: new Date().toISOString() }));
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(plain);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadPattern(id: string): Promise<Pattern | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function listPatterns(): Promise<Pattern[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function deletePattern(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Local version history (named snapshots) ---------------------------------
// Lets users keep named versions of a pattern entirely on-device — no login, no cloud. Each record
// stores a full pattern snapshot under a generated id, indexed by the source pattern id.

export interface VersionRecord {
  id: string;
  patternId: string;
  versionNumber: number;
  name: string;
  savedAt: string;
  snapshot: Pattern;
}

export async function saveVersion(patternId: string, name: string, snapshot: Pattern, versionNumber: number): Promise<VersionRecord> {
  const db = await openDB();
  const rec: VersionRecord = {
    id: `ver_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    patternId, name, versionNumber,
    savedAt: new Date().toISOString(),
    snapshot: JSON.parse(JSON.stringify(snapshot))
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VERSIONS_STORE, 'readwrite');
    tx.objectStore(VERSIONS_STORE).put(rec);
    tx.oncomplete = () => resolve(rec);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listVersions(patternId: string): Promise<VersionRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const idx = db.transaction(VERSIONS_STORE, 'readonly').objectStore(VERSIONS_STORE).index('patternId');
    const req = idx.getAll(patternId);
    req.onsuccess = () => resolve((req.result || []).sort((a: VersionRecord, b: VersionRecord) => b.savedAt.localeCompare(a.savedAt)));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteVersion(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VERSIONS_STORE, 'readwrite');
    tx.objectStore(VERSIONS_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
