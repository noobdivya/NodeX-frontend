// The app's IndexedDB database, which lives only on this device.
const DB_NAME = "nodex-keystore";
const DB_VERSION = 3;

export const STORES = {
  /** The device key and the encrypted identity. */
  vault: "vault",
  /** Contacts saved by each identity. */
  contacts: "contacts",
  /** Local profile data (photo), keyed by Peer ID. */
  profile: "profile",
} as const;

type StoreName = (typeof STORES)[keyof typeof STORES];

// Stores from earlier, server-based versions (password-encrypted keys,
// server signing keys, username-based contacts). Removed on upgrade.
const LEGACY_STORES = ["identities", "signingKeys", "contacts"];

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser does not support secure local key storage (IndexedDB)."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion > 0 && e.oldVersion < 3) {
        for (const name of LEGACY_STORES) {
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        }
      }
      if (!db.objectStoreNames.contains(STORES.vault)) {
        db.createObjectStore(STORES.vault, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.contacts)) {
        const contacts = db.createObjectStore(STORES.contacts, { keyPath: ["ownerPeerId", "peerId"] });
        contacts.createIndex("byOwner", "ownerPeerId");
      }
      if (!db.objectStoreNames.contains(STORES.profile)) {
        db.createObjectStore(STORES.profile, { keyPath: "peerId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Runs one request in a transaction on a single store and resolves with its result. */
export async function withStore<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
