// Device-local vault for the NodeX identity. There is no password: the
// libp2p private key is encrypted with a NON-EXTRACTABLE AES-GCM key that
// this browser generated and can use but never export. Nothing here is ever
// sent anywhere. Logging out deletes the identity; the 12-word phrase (with
// email and handle) restores it.
import { STORES, withStore } from "./db";
import { fromBase64, toBase64 } from "./encoding";
import { normalizeHandle } from "./handle";

const DEVICE_KEY_ID = "deviceKey";
const IDENTITY_ID = "identity";

export type StoredIdentity = {
  id: typeof IDENTITY_ID;
  peerId: string;
  /** Display form, e.g. "Rahul#Z7NJR2". */
  handle: string;
  /** Canonical lowercase form used for comparisons, e.g. "rahul#z7njr2". */
  handleKey: string;
  publicKey: string;
  emailCommitment: string;
  encryptedPrivateKey: { iv: string; ciphertext: string };
  createdAt: string;
};

async function deviceKey(): Promise<CryptoKey> {
  const existing = await withStore(
    STORES.vault,
    "readonly",
    (s) => s.get(DEVICE_KEY_ID) as IDBRequest<{ id: string; key: CryptoKey } | undefined>,
  );
  if (existing) return existing.key;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await withStore(STORES.vault, "readwrite", (s) => s.put({ id: DEVICE_KEY_ID, key }));
  return key;
}

/** Encrypts the private key with the device key and saves the identity. */
export async function saveIdentity(params: {
  peerId: string;
  handle: string;
  handleKey: string;
  publicKey: string;
  emailCommitment: string;
  privateKey: Uint8Array;
}): Promise<void> {
  const key = await deviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      // Bind the ciphertext to its Peer ID so records can't be swapped.
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(params.peerId) },
      key,
      new Uint8Array(params.privateKey),
    ),
  );
  const record: StoredIdentity = {
    id: IDENTITY_ID,
    peerId: params.peerId,
    handle: params.handle,
    handleKey: params.handleKey,
    publicKey: params.publicKey,
    emailCommitment: params.emailCommitment,
    encryptedPrivateKey: { iv: toBase64(iv), ciphertext: toBase64(ciphertext) },
    createdAt: new Date().toISOString(),
  };
  await withStore(STORES.vault, "readwrite", (s) => s.put(record));
}

/** The identity on this device, if any (i.e. whether the user is logged in). */
export async function getIdentity(): Promise<StoredIdentity | undefined> {
  const record = await withStore(
    STORES.vault,
    "readonly",
    (s) => s.get(IDENTITY_ID) as IDBRequest<StoredIdentity | undefined>,
  );
  // Records saved before handleKey existed: derive it from the handle.
  if (record && !record.handleKey) record.handleKey = normalizeHandle(record.handle) ?? record.handle.toLowerCase();
  return record;
}

/** Decrypts the private key (protobuf bytes) for use by the P2P layer. */
export async function unlockPrivateKey(record: StoredIdentity): Promise<Uint8Array> {
  const key = await deviceKey();
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(record.encryptedPrivateKey.iv),
        additionalData: new TextEncoder().encode(record.peerId),
      },
      key,
      fromBase64(record.encryptedPrivateKey.ciphertext),
    ),
  );
}

/** Logs out: removes the identity (and its key) from this device. */
export async function clearIdentity(): Promise<void> {
  await withStore(STORES.vault, "readwrite", (s) => s.delete(IDENTITY_ID));
}
