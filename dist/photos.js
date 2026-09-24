// Profile photos, kept in IndexedDB rather than chrome.storage.local.
//
// Two reasons. The scraping loop reads the whole storage area in several places,
// so a few thousand avatars sitting in there would mean re-reading megabytes on
// every list page. And IndexedDB stores Blobs as-is, where chrome.storage would
// force base64 and a third more bytes.

(() => {
  'use strict';

  const DB_NAME = 'exportin';
  const STORE = 'photos';
  let dbPromise = null;

  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode, run) {
    const handle = await db();
    return new Promise((resolve, reject) => {
      const transaction = handle.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      if (request) request.onsuccess = () => resolve(request.result);
      else transaction.oncomplete = () => resolve();
    });
  }

  const put = (id, blob, type) => tx('readwrite', (s) => s.put({ blob, type, at: Date.now() }, id));
  const get = (id) => tx('readonly', (s) => s.get(id));
  const count = () => tx('readonly', (s) => s.count());
  const clear = () => tx('readwrite', (s) => s.clear());

  // Clearing one network must not take the other one's photos with it.
  const remove = (keys) => tx('readwrite', (s) => { for (const k of keys) s.delete(k); });
  const ids = async () => new Set(await tx('readonly', (s) => s.getAllKeys()));

  // Returns [{id, blob, type}] for every stored photo. Fine for a few thousand
  // small avatars; a much larger set would want a cursor instead.
  async function all() {
    const keys = await tx('readonly', (s) => s.getAllKeys());
    const values = await tx('readonly', (s) => s.getAll());
    return keys.map((id, i) => ({ id, ...values[i] }));
  }

  const EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  const extFor = (type) => EXT[String(type).split(';')[0].trim()] || 'jpg';

  globalThis.PHOTOS = { put, get, count, clear, remove, ids, all, extFor };
})();
