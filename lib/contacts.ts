// Contacts are saved on this device only, per identity. A contact is a
// handle plus the Peer ID the P2P layer uses to reach them.
import { STORES, withStore } from "./db";
import { normalizeHandle } from "./handle";

export type Contact = {
  ownerPeerId: string;
  peerId: string;
  /** Display form, e.g. "Rahul#Z7NJR2". */
  handle: string;
  /** Canonical lowercase form used for comparisons and lookups. */
  handleKey: string;
  addedAt: string;
};

export async function listContacts(ownerPeerId: string): Promise<Contact[]> {
  const all = await withStore(
    STORES.contacts,
    "readonly",
    (s) => s.index("byOwner").getAll(ownerPeerId) as IDBRequest<Contact[]>,
  );
  return all.sort((a, b) => (a.handleKey < b.handleKey ? -1 : a.handleKey > b.handleKey ? 1 : 0));
}

/** Finds a saved contact by handle, ignoring case. */
export async function findContactByHandle(ownerPeerId: string, handle: string): Promise<Contact | undefined> {
  const key = normalizeHandle(handle);
  if (!key) return undefined;
  return (await listContacts(ownerPeerId)).find((c) => c.handleKey === key);
}

export async function addContact(ownerPeerId: string, contact: { peerId: string; handle: string }): Promise<void> {
  const handleKey = normalizeHandle(contact.handle);
  if (!handleKey) throw new Error("Invalid handle.");
  const record: Contact = { ownerPeerId, ...contact, handleKey, addedAt: new Date().toISOString() };
  await withStore(STORES.contacts, "readwrite", (s) => s.put(record));
}

export async function removeContact(ownerPeerId: string, peerId: string): Promise<void> {
  await withStore(STORES.contacts, "readwrite", (s) => s.delete([ownerPeerId, peerId]));
}
