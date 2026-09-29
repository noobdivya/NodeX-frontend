// Device-local keystore. The libp2p private key is encrypted with AES-GCM
// under a key derived from the user's password (PBKDF2-SHA256) and kept in
// IndexedDB. It is never sent to the backend.
import { toBase64 } from "./encoding";

const DB_NAME = "nodex-keystore";
const STORE = "identities";
const PBKDF2_ITERATIONS = 600_000;

export type StoredIdentity = {
  peerId: string;
  username: string;
  publicKey: string;
  encryptedPrivateKey: {
    cipher: "AES-GCM-256";
    kdf: "PBKDF2-SHA256";
    iterations: number;
    salt: string;
    iv: string;
    ciphertext: string;
  };
  createdAt: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser does not support secure local key storage (IndexedDB)."));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "peerId" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts the private key and saves it on this device. */
export async function saveIdentity(params: {
  peerId: string;
  username: string;
  publicKey: string;
  privateKey: Uint8Array;
  password: string;
}): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(params.password, salt, PBKDF2_ITERATIONS);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      // Bind the ciphertext to its Peer ID so records can't be swapped.
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(params.peerId) },
      key,
      new Uint8Array(params.privateKey),
    ),
  );

  const record: StoredIdentity = {
    peerId: params.peerId,
    username: params.username,
    publicKey: params.publicKey,
    encryptedPrivateKey: {
      cipher: "AES-GCM-256",
      kdf: "PBKDF2-SHA256",
      iterations: PBKDF2_ITERATIONS,
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(ciphertext),
    },
    createdAt: new Date().toISOString(),
  };
  await withStore("readwrite", (s) => s.put(record));
}

export async function deleteIdentity(peerId: string): Promise<void> {
  await withStore("readwrite", (s) => s.delete(peerId));
}
