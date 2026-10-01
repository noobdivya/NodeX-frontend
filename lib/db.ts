// The app's IndexedDB database, which lives only on this device.
const DB_NAME = "nodex-keystore";
/** Lowest schema version this code expects. */
const MIN_VERSION = 4;

export const STORES = {
  /** The device key and the encrypted identity. */
  vault: "vault",
  /** Contacts saved by each identity. */
  contacts: "contacts",
  /** Local profile data (photo), keyed by Peer ID. */
  profile: "profile",
  /** Chat messages, sent and received, stored only on this device. */
  messages: "messages",
} as const;

type StoreName = (typeof STORES)[keyof typeof STORES];

// Stores from earlier, server-based versions (password-encrypted keys,
// server signing keys, username-based contacts). Removed on upgrade.
const LEGACY_STORES = ["identities", "signingKeys", "contacts"];

/** Creates any missing stores; removes stores left by the old server-based app. */
function upgrade(db: IDBDatabase, oldVersion: number) {
  // Only genuinely old databases (which still have server-era stores) are cleaned.
  const isLegacy = db.objectStoreNames.contains("identities") || db.objectStoreNames.contains("signingKeys");
  if (oldVersion > 0 && oldVersion < 3 && isLegacy) {
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
  if (!db.objectStoreNames.contains(STORES.messages)) {
    const messages = db.createObjectStore(STORES.messages, { keyPath: "id" });
    messages.createIndex("byConversation", ["ownerPeerId", "peerId"]);
    messages.createIndex("byStatus", ["ownerPeerId", "status"]);
  }
}

function open(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser does not support secure local key storage (IndexedDB)."));
      return;
    }
    const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion);
    req.onsuccess = () => {
      const db = req.result;
      // Let other tabs upgrade the schema instead of being blocked by us.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Opens the database at its current version and, if it's older than this
 * code expects or any store is missing (e.g. an interrupted upgrade), bumps
 * the version once so the missing stores are created. Existing data is kept.
 */
async function openDb(): Promise<IDBDatabase> {
  const db = await open();
  const missing = Object.values(STORES).some((s) => !db.objectStoreNames.contains(s));
  if (db.version >= MIN_VERSION && !missing) return db;
  const next = Math.max(db.version + 1, MIN_VERSION);
  db.close();
  try {
    return await open(next);
  } catch (err) {
    // Another tab upgraded first; its version already has every store.
    if (err instanceof DOMException && err.name === "VersionError") return open();
    throw err;
  }
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
