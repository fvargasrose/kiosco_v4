/**
 * IndexedDB cache for standby media Blobs.
 * Stores { hash, blob } so the kiosk can serve media locally
 * without re-downloading on every restart.
 */

const DB_NAME = 'dentalkiosco-standby';
const STORE   = 'media';
const DB_VER  = 1;

let _db = null;

async function openDb() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE);
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror   = (e) => reject(e.target.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function idbPut(store, key, value) {
  return new Promise((resolve, reject) => {
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

function idbClear(store) {
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/** Returns cached { hash, blob } or null */
export async function getMedia() {
  try {
    const db = await openDb();
    return idbGet(tx(db, 'readonly'), 'entry');
  } catch {
    return null;
  }
}

/** Saves { hash, blob } to IndexedDB (replaces previous entry) */
export async function saveMedia(hash, blob) {
  try {
    const db = await openDb();
    await idbPut(tx(db, 'readwrite'), 'entry', { hash, blob });
  } catch (err) {
    console.warn('[standby-cache] saveMedia failed', err);
  }
}

/** Clears all cached media */
export async function clearMedia() {
  try {
    const db = await openDb();
    await idbClear(tx(db, 'readwrite'));
  } catch (err) {
    console.warn('[standby-cache] clearMedia failed', err);
  }
}
