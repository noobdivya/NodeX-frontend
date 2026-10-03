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
  /**
   * When this device was last connected to them (ms since epoch). Recorded
   * here, from this device's own connections; no server tracks it.
   */
  lastSeen?: number;
  /**
   * Blocked by this user: this device refuses their connections, messages,
   * file and photo requests. Kept only here; nobody else is told.
   */
  blocked?: boolean;
  /**
   * Added automatically because they messaged this user, not saved by the
   * user. Such people don't count as "my contacts" (e.g. for photo privacy).
   */
  auto?: boolean;
};

/** People this user saved themselves (not just people who messaged them). */
export async function isSavedContact(ownerPeerId: string, peerId: string): Promise<boolean> {
  const c = await getContact(ownerPeerId, peerId);
  return !!c && !c.auto;
}

export async function setContactBlocked(ownerPeerId: string, peerId: string, blocked: boolean): Promise<void> {
  const contact = await getContact(ownerPeerId, peerId);
  if (!contact) return;
  await withStore(STORES.contacts, "readwrite", (s) => s.put({ ...contact, blocked }));
}

export async function getContact(ownerPeerId: string, peerId: string): Promise<Contact | undefined> {
  return withStore(
    STORES.contacts,
    "readonly",
    (s) => s.get([ownerPeerId, peerId]) as IDBRequest<Contact | undefined>,
  );
}

/** Notes that a contact was online just now. Peers that aren't contacts are ignored. */
export async function touchLastSeen(ownerPeerId: string, peerId: string, at = Date.now()): Promise<void> {
  const contact = await getContact(ownerPeerId, peerId);
  if (!contact || (contact.lastSeen ?? 0) >= at) return;
  await withStore(STORES.contacts, "readwrite", (s) => s.put({ ...contact, lastSeen: at }));
}

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

export async function addContact(
  ownerPeerId: string,
  contact: { peerId: string; handle: string; auto?: boolean },
): Promise<void> {
  const handleKey = normalizeHandle(contact.handle);
  if (!handleKey) throw new Error("Invalid handle.");
  // Re-adding keeps what this device already knows about them (last seen, blocked).
  const existing = await getContact(ownerPeerId, contact.peerId);
  const record: Contact = { ...existing, ownerPeerId, ...contact, handleKey, addedAt: new Date().toISOString() };
  // Saving someone yourself makes them a real contact.
  if (!contact.auto) delete record.auto;
  await withStore(STORES.contacts, "readwrite", (s) => s.put(record));
}

export async function removeContact(ownerPeerId: string, peerId: string): Promise<void> {
  await withStore(STORES.contacts, "readwrite", (s) => s.delete([ownerPeerId, peerId]));
}
