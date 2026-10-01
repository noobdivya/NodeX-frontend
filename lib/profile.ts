// Profile photos, stored only on this device: the user's own photo, plus
// copies of other people's photos received peer to peer
// (lib/p2p/profile-share.ts). Never uploaded to a server.
import { STORES, withStore } from "./db";

export type ProfileRecord = {
  peerId: string;
  avatar?: Blob;
  /** SHA-256 (hex) of the photo bytes, used to detect changes. */
  hash?: string;
  updatedAt?: number;
};

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(sum, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getProfile(peerId: string): Promise<ProfileRecord | undefined> {
  return withStore(STORES.profile, "readonly", (s) => s.get(peerId) as IDBRequest<ProfileRecord | undefined>);
}

export async function getAvatar(peerId: string): Promise<Blob | undefined> {
  return (await getProfile(peerId))?.avatar;
}

export async function setAvatar(peerId: string, avatar: Blob, hash?: string): Promise<void> {
  const h = hash ?? (await sha256Hex(new Uint8Array(await avatar.arrayBuffer())));
  const record: ProfileRecord = { peerId, avatar, hash: h, updatedAt: Date.now() };
  await withStore(STORES.profile, "readwrite", (s) => s.put(record));
}

export async function removeAvatar(peerId: string): Promise<void> {
  await withStore(STORES.profile, "readwrite", (s) => s.delete(peerId));
}

/** Photos for several people at once (missing ones are left out). */
export async function getAvatars(peerIds: string[]): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>();
  for (const id of peerIds) {
    const blob = await getAvatar(id);
    if (blob) out.set(id, blob);
  }
  return out;
}
