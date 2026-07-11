import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Minimal in-memory IndexedDB fake — only the surface audioStore.js touches:
 *   indexedDB.open / onupgradeneeded / onsuccess
 *   db.objectStoreNames.contains / createObjectStore / transaction
 *   tx.objectStore / store.put / store.get / store.delete / tx.oncomplete
 * It mimics IndexedDB's async callback style (callbacks fire on a later
 * macrotask) so the promise-based wrappers resolve realistically.
 *
 * jsdom does not ship IndexedDB, so without this fake the happy-path tests
 * could not run. We also test the "IndexedDB missing" path to ensure the
 * store degrades gracefully (returns null / no-op, never throws).
 */
function createFakeIndexedDB() {
  // dbName -> { stores: Map<storeName, Map<key, record>> }
  const databases = new Map();

  const makeReq = () => ({ result: null, error: null, onsuccess: null, onerror: null });
  const schedule = (fn) => setTimeout(fn, 0);

  function makeTransaction(dbState, storeName) {
    const storeMap = dbState.stores.get(storeName);
    const store = {
      put(record) {
        storeMap.set(record.messageId, record);
        return makeReq();
      },
      get(key) {
        const req = makeReq();
        req.result = storeMap.get(key) || null;
        schedule(() => { if (req.onsuccess) req.onsuccess(); });
        return req;
      },
      delete(key) {
        storeMap.delete(key);
        return makeReq();
      },
    };
    const tx = { objectStore: () => store, oncomplete: null, onerror: null, onabort: null };
    schedule(() => { if (tx.oncomplete) tx.oncomplete(); });
    return tx;
  }

  const fakeIDB = {
    open(dbName) {
      const req = makeReq();
      schedule(() => {
        let dbState = databases.get(dbName);
        let needsUpgrade = false;
        if (!dbState) {
          dbState = { stores: new Map() };
          databases.set(dbName, dbState);
          needsUpgrade = true;
        }
        const db = {
          objectStoreNames: { contains: (n) => dbState.stores.has(n) },
          createObjectStore: (n) => {
            dbState.stores.set(n, new Map());
            return { name: n };
          },
          transaction: (n) => makeTransaction(dbState, n),
          close: () => {},
        };
        req.result = db;
        if (needsUpgrade && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };

  return { fakeIDB, databases };
}

let fake;
beforeEach(() => {
  fake = createFakeIndexedDB();
  Object.defineProperty(globalThis, 'indexedDB', {
    value: fake.fakeIDB,
    configurable: true,
    writable: true,
  });
  // Fresh module per test => fresh dbPromise singleton + clean in-memory store.
  vi.resetModules();
});
afterEach(() => {
  delete globalThis.indexedDB;
});

// Dynamic import so vi.resetModules() in beforeEach takes effect each test.
const load = () => import('./audioStore.js');

describe('audioStore — happy path (IndexedDB available)', () => {
  it('saveAudio then loadAudio returns the same blob (identity + size + type)', async () => {
    const { saveAudio, loadAudio } = await load();
    const blob = new Blob(['hello audio world'], { type: 'audio/webm' });

    await saveAudio('msg-1', blob);
    const got = await loadAudio('msg-1');

    expect(got).not.toBeNull();
    expect(got).toBe(blob); // exact same object we stored
    expect(got.size).toBe(blob.size); // content length preserved
    expect(got.type).toBe('audio/webm');
  });

  it('loadAudio returns null for an id that was never saved', async () => {
    const { loadAudio } = await load();
    expect(await loadAudio('never-saved')).toBeNull();
  });

  it('deleteAudio makes a subsequent loadAudio return null', async () => {
    const { saveAudio, loadAudio, deleteAudio } = await load();
    const blob = new Blob(['to be deleted'], { type: 'audio/webm' });

    await saveAudio('msg-2', blob);
    expect(await loadAudio('msg-2')).not.toBeNull();

    await deleteAudio('msg-2');
    expect(await loadAudio('msg-2')).toBeNull();
  });
});

describe('audioStore — IndexedDB unavailable (graceful degradation)', () => {
  it('never throws: loadAudio yields null and deleteAudio is a no-op', async () => {
    // Simulate an environment without IndexedDB (private mode / unsupported).
    globalThis.indexedDB = undefined;
    vi.resetModules();
    const { saveAudio, loadAudio, deleteAudio } = await load();

    // saveAudio must not throw synchronously and settles (rejects) quietly.
    await expect(saveAudio('x', new Blob(['a']))).rejects.toBeDefined();
    // Reading / deleting must resolve without throwing.
    expect(await loadAudio('x')).toBeNull();
    await expect(deleteAudio('x')).resolves.toBeUndefined();
  });
});
