/**
 * audioStore.js
 *
 * Persists user voice-message audio blobs (audioBlob) in IndexedDB so they
 * survive a page refresh and can be replayed from chat history. localStorage
 * cannot store binary blobs, so the App keeps only transcript text in
 * localStorage and uses this store for the binary audio, keyed by message id.
 *
 * All functions are async and fail silently (resolving to null / no-op) when
 * IndexedDB is unavailable (e.g. private mode or unsupported browser), so text
 * history is never blocked by audio persistence problems.
 */

const DB_NAME = 'xiaoliao-audio';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

/** @type {Promise<IDBDatabase> | null} Cached DB-open promise (one per page). */
let dbPromise = null;

/**
 * Open (or reuse) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'messageId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
  return dbPromise;
}

/**
 * Save (or overwrite) an audio blob for a message.
 * @param {string} messageId
 * @param {Blob} blob
 * @returns {Promise<void>}
 */
async function saveAudio(messageId, blob) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ messageId, blob });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('saveAudio transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('saveAudio transaction aborted'));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Load the audio blob for a message.
 * @param {string} messageId
 * @returns {Promise<Blob|null>} The blob, or null if not found / unavailable.
 */
async function loadAudio(messageId) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(messageId);
        req.onsuccess = () => {
          const record = req.result;
          resolve(record && record.blob ? record.blob : null);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

/**
 * Delete the audio blob for a message (best effort).
 * @param {string} messageId
 * @returns {Promise<void>}
 */
async function deleteAudio(messageId) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(messageId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {
    // ignore — deleting audio must never throw into the caller
  }
}

export { saveAudio, loadAudio, deleteAudio };
