import { browser } from '$app/environment';
import type { Pattern } from '@seamer/pattern-model';
import {
  IndexedDbHistoryPersistence,
  LocalDocumentStore,
  createDoc,
  type HistoryEntry
} from '@atelier/core';

const LEGACY_DB_NAME = 'seamer-patterns';
const LEGACY_PATTERNS_STORE = 'patterns';
const LEGACY_HISTORY_STORE = 'history';
const LEGACY_VERSIONS_STORE = 'versions';

const DOCUMENT_DB_NAME = 'seamer-studio-documents';
const DOCUMENT_DB_VERSION = 1;
const DOCUMENT_VERSIONS_STORE = 'versions';
const MIGRATION_KEY = 'seamer.local-documents-migrated.v1';

const documents = new LocalDocumentStore<Pattern>({
  dbName: DOCUMENT_DB_NAME,
  version: DOCUMENT_DB_VERSION
});
const history = new IndexedDbHistoryPersistence<Pattern>({
  dbName: 'seamer-studio',
  storeName: 'history',
  version: 1
});

interface LegacyPattern extends Pattern {
  updatedAt?: string;
}

interface LegacyHistoryRecord {
  patternId: string;
  undo: Array<{ pattern: Pattern; label: string }>;
  redo: Array<{ pattern: Pattern; label: string }>;
  savedAt: string;
}

interface LegacyVersionRecord {
  id: string;
  patternId: string;
  versionNumber: number;
  name: string;
  savedAt: string;
  snapshot: Pattern;
}

interface LegacyRecords {
  patterns: LegacyPattern[];
  history: LegacyHistoryRecord[];
  versions: LegacyVersionRecord[];
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB migration request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB migration transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB migration transaction aborted'));
  });
}

function openDatabase(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined
      ? indexedDB.open(name)
      : indexedDB.open(name, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error(`Could not open IndexedDB database "${name}"`));
    request.onblocked = () =>
      reject(new Error(`Opening IndexedDB database "${name}" was blocked`));
  });
}

async function readStore<T>(database: IDBDatabase, storeName: string): Promise<T[]> {
  if (!database.objectStoreNames.contains(storeName)) return [];
  return requestResult(
    database
      .transaction(storeName, 'readonly')
      .objectStore(storeName)
      .getAll() as IDBRequest<T[]>
  );
}

async function readLegacyRecords(): Promise<LegacyRecords> {
  const database = await openDatabase(LEGACY_DB_NAME);
  try {
    const [patterns, legacyHistory, versions] = await Promise.all([
      readStore<LegacyPattern>(database, LEGACY_PATTERNS_STORE),
      readStore<LegacyHistoryRecord>(database, LEGACY_HISTORY_STORE),
      readStore<LegacyVersionRecord>(database, LEGACY_VERSIONS_STORE)
    ]);
    return { patterns, history: legacyHistory, versions };
  } finally {
    database.close();
  }
}

function historyEntries(
  patternId: string,
  savedAt: string,
  entries: Array<{ pattern: Pattern; label: string }>
): Array<HistoryEntry<Pattern>> {
  const parsedAt = Date.parse(savedAt);
  const at = Number.isFinite(parsedAt) ? parsedAt : Date.now();
  return entries.map((entry) => ({
    doc: createDoc(entry.pattern, {
      id: patternId,
      name: entry.pattern.name,
      updatedAt: savedAt
    }),
    label: entry.label,
    at
  }));
}

async function migrateVersions(versions: LegacyVersionRecord[]): Promise<void> {
  if (versions.length === 0) return;
  // Ensure LocalDocumentStore has created its fixed documents/versions schema first.
  await documents.list();
  const database = await openDatabase(DOCUMENT_DB_NAME, DOCUMENT_DB_VERSION);
  try {
    const transaction = database.transaction(DOCUMENT_VERSIONS_STORE, 'readwrite');
    const store = transaction.objectStore(DOCUMENT_VERSIONS_STORE);
    for (const version of versions) {
      store.put({
        id: version.id,
        documentId: version.patternId,
        name: version.name,
        savedAt: version.savedAt,
        snapshot: {
          ...version.snapshot,
          versionNumber: version.versionNumber
        }
      });
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

let migrationPromise: Promise<void> | null = null;

async function migrateLegacyRecords(): Promise<void> {
  if (!browser) throw new Error('IndexedDB is unavailable outside the browser');
  if (localStorage.getItem(MIGRATION_KEY) === 'complete') return;

  const legacy = await readLegacyRecords();
  for (const pattern of legacy.patterns) {
    // Destination data wins if the app has already saved this document using the engine layer.
    if (await documents.load(pattern.id) === null) {
      await documents.save(pattern.id, pattern.name, pattern);
    }
  }
  await migrateVersions(legacy.versions);
  for (const record of legacy.history) {
    if (await history.load(record.patternId) !== null) continue;
    await history.save(
      record.patternId,
      historyEntries(record.patternId, record.savedAt, record.undo),
      historyEntries(record.patternId, record.savedAt, record.redo)
    );
  }
  localStorage.setItem(MIGRATION_KEY, 'complete');
}

function ensureMigrated(): Promise<void> {
  migrationPromise ??= migrateLegacyRecords().catch((error: unknown) => {
    migrationPromise = null;
    throw error;
  });
  return migrationPromise;
}

export async function savePattern(pattern: Pattern): Promise<void> {
  await ensureMigrated();
  await documents.save(pattern.id, pattern.name, pattern);
}

export async function loadPattern(id: string): Promise<Pattern | null> {
  await ensureMigrated();
  return documents.load(id);
}

export async function listPatterns(): Promise<Pattern[]> {
  await ensureMigrated();
  const metadata = await documents.list();
  const loaded = await Promise.all(metadata.map((entry) => documents.load(entry.id)));
  return loaded.filter((pattern): pattern is Pattern => pattern !== null);
}

export async function deletePattern(id: string): Promise<void> {
  await ensureMigrated();
  await documents.delete(id);
}

// --- Local version history (named snapshots) ---------------------------------

export interface VersionRecord {
  id: string;
  patternId: string;
  versionNumber: number;
  name: string;
  savedAt: string;
  snapshot: Pattern;
}

export async function saveVersion(
  patternId: string,
  name: string,
  snapshot: Pattern,
  versionNumber: number
): Promise<VersionRecord> {
  await ensureMigrated();
  const storedSnapshot = { ...snapshot, versionNumber };
  const metadata = await documents.saveVersion(patternId, name, storedSnapshot);
  return {
    id: metadata.id,
    patternId: metadata.documentId,
    versionNumber,
    name: metadata.name,
    savedAt: metadata.savedAt,
    snapshot: storedSnapshot
  };
}

export async function listVersions(patternId: string): Promise<VersionRecord[]> {
  await ensureMigrated();
  const metadata = await documents.listVersions(patternId);
  const records = await Promise.all(metadata.map(async (entry): Promise<VersionRecord | null> => {
    const snapshot = await documents.loadVersion(entry.id);
    if (!snapshot) return null;
    return {
      id: entry.id,
      patternId: entry.documentId,
      versionNumber: snapshot.versionNumber,
      name: entry.name,
      savedAt: entry.savedAt,
      snapshot
    };
  }));
  return records.filter((record): record is VersionRecord => record !== null);
}

export async function deleteVersion(id: string): Promise<void> {
  await ensureMigrated();
  await documents.deleteVersion(id);
}
