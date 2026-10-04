import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pattern } from '@seamer/pattern-model';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  load: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  saveVersion: vi.fn(),
  historyLoad: vi.fn(),
  historySave: vi.fn()
}));

let durableMarker = false;
let markerFailures = 0;
let markerWrites = 0;

function stubIndexedDB(openLegacy: (...args: unknown[]) => unknown) {
  vi.stubGlobal('indexedDB', { open: vi.fn((name: string, ...args: unknown[]) => {
    if (name !== 'seamer-studio-migrations') return openLegacy(name, ...args);
    const database = {
      close: vi.fn(),
      objectStoreNames: { contains: () => true },
      transaction: () => {
        const transaction = {
          oncomplete: null as (() => void) | null,
          onabort: null as (() => void) | null,
          error: new DOMException('Marker quota exceeded', 'QuotaExceededError'),
          objectStore: () => ({
            get: () => {
              const request = { result: durableMarker ? { complete: true } : undefined, onsuccess: null as (() => void) | null };
              queueMicrotask(() => request.onsuccess?.());
              return request;
            },
            put: () => {
              markerWrites += 1;
              queueMicrotask(() => {
                if (markerFailures > 0) { markerFailures -= 1; transaction.onabort?.(); }
                else { durableMarker = true; transaction.oncomplete?.(); }
              });
            }
          })
        };
        return transaction;
      }
    };
    const request = { result: database, onsuccess: null as (() => void) | null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }) });
}

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('@atelier/core', () => ({
  LocalDocumentStore: class {
    save = mocks.save;
    load = mocks.load;
    list = mocks.list;
    delete = mocks.delete;
    saveVersion = mocks.saveVersion;
  },
  IndexedDbHistoryPersistence: class {
    load = mocks.historyLoad;
    save = mocks.historySave;
  },
  createDoc: vi.fn()
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  durableMarker = false;
  markerFailures = 0;
  markerWrites = 0;
  mocks.save.mockResolvedValue(undefined);
  mocks.load.mockResolvedValue(null);
  mocks.list.mockResolvedValue([]);
  mocks.delete.mockResolvedValue(undefined);
  mocks.historyLoad.mockResolvedValue(null);
  mocks.historySave.mockResolvedValue(undefined);
  mocks.saveVersion.mockResolvedValue({ id: 'v1', documentId: 'pattern', name: 'Snapshot', savedAt: '2026-10-02' });
  // An empty legacy database is enough to exercise the real migration gate.
  stubIndexedDB(() => {
      const request = {
        result: { objectStoreNames: { contains: () => false }, close: vi.fn() },
        onsuccess: null as (() => void) | null
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    });
});

afterEach(() => { vi.unstubAllGlobals(); });

function legacyDatabase(records: Record<string, unknown[]>) {
  stubIndexedDB(() => {
    const database = {
      close: vi.fn(),
      objectStoreNames: { contains: (name: string) => name in records },
      transaction: (name: string) => ({ objectStore: () => ({ getAll: () => {
        const request = { result: records[name], onsuccess: null as (() => void) | null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      } }) })
    };
    const request = { result: database, onsuccess: null as (() => void) | null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  });
}

describe('local document migration with restricted storage', () => {
  it('does not resurrect deleted legacy documents on a new launch with blocked localStorage', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('Blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('Blocked', 'SecurityError'); }
    });
    const old = { id: 'old', name: 'Legacy' } as Pattern;
    legacyDatabase({ patterns: [old] });
    const firstLaunch = await import('./localDB');
    await firstLaunch.listPatterns();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    await firstLaunch.deletePattern(old.id);
    expect(mocks.delete).toHaveBeenCalledWith(old.id);
    vi.resetModules();
    const nextLaunch = await import('./localDB');
    await nextLaunch.listPatterns();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(markerWrites).toBe(1);
    expect(indexedDB.open).toHaveBeenCalledWith('seamer-patterns');
    expect(vi.mocked(indexedDB.open).mock.calls.filter(([name]) => name === 'seamer-patterns')).toHaveLength(1);
  });

  it('retries a failed durable marker transaction after destination migration succeeds', async () => {
    const marker = { getItem: () => null, setItem: vi.fn() };
    vi.stubGlobal('localStorage', marker);
    const old = { id: 'old', name: 'Legacy' } as Pattern;
    legacyDatabase({ patterns: [old] });
    markerFailures = 1;
    mocks.save.mockImplementation(async () => { mocks.load.mockResolvedValue(old); });
    const { listPatterns } = await import('./localDB');
    await expect(listPatterns()).rejects.toThrow('Marker quota exceeded');
    expect(marker.setItem).not.toHaveBeenCalled();
    expect(durableMarker).toBe(false);
    await expect(listPatterns()).resolves.toEqual([]);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(markerWrites).toBe(2);
    expect(durableMarker).toBe(true);
    expect(marker.setItem).toHaveBeenCalledOnce();
  });

  it('bootstraps a durable marker from existing localStorage completion without replaying legacy data', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'complete' });
    const { listPatterns } = await import('./localDB');
    await listPatterns();
    expect(markerWrites).toBe(1);
    expect(durableMarker).toBe(true);
    expect(vi.mocked(indexedDB.open).mock.calls.some(([name]) => name === 'seamer-patterns')).toBe(false);
  });

  it('preserves destination documents and history when replaying migration', async () => {
    const marker = { getItem: () => null, setItem: vi.fn() };
    vi.stubGlobal('localStorage', marker);
    const old = { id: 'old', name: 'Legacy' } as Pattern;
    legacyDatabase({
      patterns: [old],
      history: [{ patternId: 'old', savedAt: '2025-01-01', undo: [], redo: [] }]
    });
    mocks.load.mockResolvedValue({ ...old, name: 'Current' });
    mocks.historyLoad.mockResolvedValue({ undo: [{ label: 'Current' }], redo: [] });
    const { listPatterns } = await import('./localDB');
    await listPatterns();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.historySave).not.toHaveBeenCalled();
    expect(marker.setItem).toHaveBeenCalledWith('seamer.local-documents-migrated.v1', 'complete');
  });

  it('retries failed migration without overwriting documents already migrated', async () => {
    const marker = { getItem: () => null, setItem: vi.fn() };
    vi.stubGlobal('localStorage', marker);
    const first = { id: 'first', name: 'First' } as Pattern;
    const second = { id: 'second', name: 'Second' } as Pattern;
    legacyDatabase({ patterns: [first, second] });
    const destination = new Map<string, Pattern>();
    mocks.load.mockImplementation(async (id: string) => destination.get(id) ?? null);
    let fail = true;
    mocks.save.mockImplementation(async (id: string, _name: string, pattern: Pattern) => {
      if (id === 'second' && fail) { fail = false; throw new Error('migration disk full'); }
      destination.set(id, pattern);
    });
    const { listPatterns } = await import('./localDB');
    await expect(listPatterns()).rejects.toThrow('migration disk full');
    expect(marker.setItem).not.toHaveBeenCalled();
    await expect(listPatterns()).resolves.toEqual([]);
    expect(mocks.save.mock.calls.map(([id]) => id)).toEqual(['first', 'second', 'second']);
    expect(marker.setItem).toHaveBeenCalledOnce();
    expect(destination.size).toBe(2);
  });

  it('captures document and named version data before asynchronous migration', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    const { savePattern, saveVersion } = await import('./localDB');
    const source = { id: 'pattern', name: 'Initial', points: [{ x: 1, y: 2 }] } as Pattern;
    // Reactive proxies are valid callers, but are not directly structuredClone-able.
    const proxy = new Proxy(source, {});
    const save = savePattern(proxy);
    const version = saveVersion(source.id, 'Snapshot', proxy, 3);
    source.name = 'Edited';
    source.points[0].x = 99;
    await save;
    const receipt = await version;
    expect(mocks.save.mock.calls[0][2]).toMatchObject({ name: 'Initial', points: [{ x: 1, y: 2 }] });
    expect(mocks.saveVersion.mock.calls[0][2]).toMatchObject({ name: 'Initial', versionNumber: 3, points: [{ x: 1, y: 2 }] });
    expect(receipt.snapshot.points[0].x).toBe(1);
    expect(indexedDB.open).toHaveBeenCalledTimes(3);
  });

  it('saves with IndexedDB when accessing the localStorage marker throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('Storage blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('Storage blocked', 'SecurityError'); }
    });
    const { savePattern } = await import('./localDB');
    const pattern = { id: 'pattern', name: 'A pattern' } as Pattern;
    await expect(savePattern(pattern)).resolves.toBeUndefined();
    await expect(savePattern(pattern)).resolves.toBeUndefined();
    expect(mocks.save).toHaveBeenCalledTimes(2);
    // Successful migration remains cached without a writable localStorage marker.
    expect(indexedDB.open).toHaveBeenCalledTimes(3);
  });

  it('keeps saves usable when reading the marker works but writing it fails', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new DOMException('Storage full', 'QuotaExceededError'); }
    });
    const { savePattern } = await import('./localDB');
    const pattern = { id: 'pattern', name: 'A pattern' } as Pattern;
    await expect(savePattern(pattern)).resolves.toBeUndefined();
    expect(mocks.save).toHaveBeenCalledWith(pattern.id, pattern.name, pattern);
  });

  it('continues to surface real document write failures', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'complete' });
    mocks.save.mockRejectedValueOnce(new Error('IndexedDB quota exceeded'));
    const { savePattern } = await import('./localDB');
    const pattern = { id: 'pattern', name: 'A pattern' } as Pattern;
    await expect(savePattern(pattern)).rejects.toThrow('IndexedDB quota exceeded');
    await expect(savePattern(pattern)).resolves.toBeUndefined();
  });

  it('preserves destination snapshots when a blocked marker causes migration to replay', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('Storage blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('Storage blocked', 'SecurityError'); }
    });
    const put = vi.fn();
    const legacyVersion = {
      id: 'existing-version', patternId: 'pattern', name: 'Old version',
      savedAt: '2020-01-01', versionNumber: 1,
      snapshot: { id: 'pattern', name: 'Old content' }
    };
    const newVersion = { ...legacyVersion, id: 'unmigrated-version' };
    stubIndexedDB((databaseName) => {
        const name = String(databaseName);
        const legacy = name === 'seamer-patterns';
        const database = {
          objectStoreNames: { contains: (store: string) => store === 'versions' },
          close: vi.fn(),
          transaction: (_store: string, mode: string) => {
            const transaction = {
              oncomplete: null as (() => void) | null,
              objectStore: () => ({
                put,
                getAll: () => {
                  const request = {
                    result: legacy ? [legacyVersion, newVersion] : [{ id: 'existing-version' }],
                    onsuccess: null as (() => void) | null
                  };
                  queueMicrotask(() => request.onsuccess?.());
                  return request;
                }
              })
            };
            if (mode === 'readwrite') queueMicrotask(() => transaction.oncomplete?.());
            return transaction;
          }
        };
        const request = { result: database, onsuccess: null as (() => void) | null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      });
    const { listPatterns } = await import('./localDB');
    await expect(listPatterns()).resolves.toEqual([]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: 'unmigrated-version' }));
  });
});
