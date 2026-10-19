// Minimal promise wrapper around IndexedDB. Everything VoxPop stores lives here,
// in this browser, on this device. Nothing is sent anywhere.

export const DB_NAME = 'voxpop';
const DB_VERSION = 1;

export type StoreName = 'kv' | 'recordings' | 'records' | 'chunks' | 'rejected';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv');
      db.createObjectStore('recordings', { keyPath: 'rid' });
      db.createObjectStore('records'); // key: [rid, i]
      db.createObjectStore('chunks'); // key: [rid, i]
      db.createObjectStore('rejected', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('storage is blocked by another open VoxPop tab'));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).get(key));
}

export async function put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  await done(tx);
}

export async function del(store: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export async function getAll<T>(store: StoreName, range?: IDBKeyRange): Promise<T[]> {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).getAll(range));
}

/** Writes several stores atomically: either all land or none do. */
export async function putMany(ops: { store: StoreName; value: unknown; key?: IDBValidKey }[]): Promise<void> {
  const db = await openDb();
  const stores = [...new Set(ops.map((o) => o.store))];
  const tx = db.transaction(stores, 'readwrite');
  for (const o of ops) tx.objectStore(o.store).put(o.value, o.key);
  await done(tx);
}

/** Range covering every [rid, i] key of one recording. */
export function ridRange(rid: string): IDBKeyRange {
  return IDBKeyRange.bound([rid, 0], [rid, Number.MAX_SAFE_INTEGER]);
}

export async function deleteRecordingData(rid: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['recordings', 'records', 'chunks', 'kv'], 'readwrite');
  tx.objectStore('recordings').delete(rid);
  tx.objectStore('records').delete(ridRange(rid));
  tx.objectStore('chunks').delete(ridRange(rid));
  tx.objectStore('kv').delete(`sk:${rid}`);
  await done(tx);
}

/** Deletes the whole database. Used by the panic wipe. */
export async function destroyDb(): Promise<void> {
  if (dbPromise) {
    try {
      (await dbPromise).close();
    } catch {
      /* already closed */
    }
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // other tabs close on versionchange; deletion completes after
  });
}
