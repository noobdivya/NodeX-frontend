// People this user has blocked. The list lives only on this device (with
// the contacts); blocking is enforced here, by refusing the blocked person's
// connections and requests. No server is involved and nobody is told.
import { listContacts, setContactBlocked } from "../contacts";

const blocked = new Set<string>();

export const isBlocked = (peerId: string) => blocked.has(peerId);

/** Loads this identity's block list into memory (checked on every connection). */
export async function loadBlocked(ownerPeerId: string): Promise<void> {
  const contacts = await listContacts(ownerPeerId);
  blocked.clear();
  for (const c of contacts) if (c.blocked) blocked.add(c.peerId);
}

export async function storeBlocked(ownerPeerId: string, peerId: string, value: boolean): Promise<void> {
  await setContactBlocked(ownerPeerId, peerId, value);
  if (value) blocked.add(peerId);
  else blocked.delete(peerId);
}
