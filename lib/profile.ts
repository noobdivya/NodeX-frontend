// Profile photo, stored only on this device. The P2P layer shares it
// directly with contacts; it is never uploaded to a server.
import { STORES, withStore } from "./db";

type ProfileRecord = { peerId: string; avatar?: Blob };

export async function getAvatar(peerId: string): Promise<Blob | undefined> {
  const r = await withStore(STORES.profile, "readonly", (s) => s.get(peerId) as IDBRequest<ProfileRecord | undefined>);
  return r?.avatar;
}

export async function setAvatar(peerId: string, avatar: Blob): Promise<void> {
  await withStore(STORES.profile, "readwrite", (s) => s.put({ peerId, avatar } satisfies ProfileRecord));
}

export async function removeAvatar(peerId: string): Promise<void> {
  await withStore(STORES.profile, "readwrite", (s) => s.delete(peerId));
}
