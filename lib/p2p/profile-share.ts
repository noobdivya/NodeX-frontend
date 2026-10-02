// Profile photos, shared directly between browsers — never via a server.
//
// Protocol /nodex/profile/1.0.0 — one stream per exchange:
//   fetch:  asker → { t: "get", have: <hash|null> }
//           owner → { t: "photo", hash, type, size } + <bytes>  |  { t: "same" }  |  { t: "none" }
//   push:   owner → { t: "photo", ... } + <bytes>  |  { t: "none" }      (when the photo changes)
//           receiver → { t: "ok" }
//
// Anyone who connects can fetch your photo (like "Everyone" in WhatsApp);
// unsolicited pushes are accepted only from your contacts. Every photo is
// checked: allowed image type, ≤ 256 KB, matching magic bytes and SHA-256.
import type { Connection, Stream } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { lpStream } from "@libp2p/utils";
import { listContacts } from "../contacts";
import type { StoredIdentity } from "../keystore";
import { getProfile, removeAvatar, setAvatar, sha256Hex } from "../profile";
import { BOOTSTRAP_PEERS, getNode, onNodeStart, openPeerStream } from "./node";

export const PROFILE_PROTOCOL = "/nodex/profile/1.0.0";
const MAX_PHOTO_BYTES = 256 * 1024;
const MAX_FRAME_BYTES = MAX_PHOTO_BYTES + 1024;
const IO_TIMEOUT_MS = 15_000;
const ALLOWED_TYPES = ["image/webp", "image/jpeg", "image/png"] as const;

type Header =
  | { t: "get"; have: string | null }
  | { t: "photo"; hash: string; type: string; size: number }
  | { t: "same" }
  | { t: "none" }
  | { t: "ok" };

const enc = new TextEncoder();
const dec = new TextDecoder();
const listeners = new Set<(peerId: string) => void>();
const inFlight = new Map<string, Promise<void>>();
const nodeIds = new Set(BOOTSTRAP_PEERS.map((a) => a.split("/p2p/").pop()));

/** Fires when someone's photo was received, changed or removed on this device. */
export function onAvatarEvent(listener: (peerId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const emit = (peerId: string) => listeners.forEach((l) => l(peerId));

const readHeader = async (lp: ReturnType<typeof lpStream>): Promise<Header> =>
  JSON.parse(dec.decode((await lp.read({ signal: AbortSignal.timeout(IO_TIMEOUT_MS) })).subarray())) as Header;
const write = (lp: ReturnType<typeof lpStream>, data: Uint8Array) =>
  lp.write(data, { signal: AbortSignal.timeout(IO_TIMEOUT_MS) });
const writeHeader = (lp: ReturnType<typeof lpStream>, h: Header) => write(lp, enc.encode(JSON.stringify(h)));

/** Whether the bytes really start like an image of the claimed type. */
export function magicMatches(type: string, b: Uint8Array): boolean {
  if (type === "image/png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (type === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/webp") {
    return dec.decode(b.subarray(0, 4)) === "RIFF" && dec.decode(b.subarray(8, 12)) === "WEBP";
  }
  return false;
}

/** Reads and checks a photo that follows a "photo" header. */
async function readPhoto(lp: ReturnType<typeof lpStream>, h: Extract<Header, { t: "photo" }>): Promise<Blob> {
  if (!(ALLOWED_TYPES as readonly string[]).includes(h.type)) throw new Error("photo type not allowed");
  if (!Number.isSafeInteger(h.size) || h.size <= 0 || h.size > MAX_PHOTO_BYTES) throw new Error("photo too large");
  const bytes = new Uint8Array((await lp.read({ signal: AbortSignal.timeout(IO_TIMEOUT_MS) })).subarray());
  if (bytes.length !== h.size) throw new Error("photo size mismatch");
  if (!magicMatches(h.type, bytes)) throw new Error("not a real image");
  if ((await sha256Hex(bytes)) !== h.hash) throw new Error("photo hash mismatch");
  return new Blob([bytes], { type: h.type });
}

async function sendOwnPhoto(lp: ReturnType<typeof lpStream>, identity: StoredIdentity, have: string | null) {
  const own = await getProfile(identity.peerId);
  if (!own?.avatar || !own.hash) return writeHeader(lp, { t: "none" });
  if (have && have === own.hash) return writeHeader(lp, { t: "same" });
  const bytes = new Uint8Array(await own.avatar.arrayBuffer());
  await writeHeader(lp, { t: "photo", hash: own.hash, type: own.avatar.type, size: bytes.length });
  await write(lp, bytes);
}

async function isContact(identity: StoredIdentity, peerId: string) {
  return (await listContacts(identity.peerId)).some((c) => c.peerId === peerId);
}

// ------------------------------------------------------------- answering

async function handle(stream: Stream, connection: Connection, identity: StoredIdentity) {
  const lp = lpStream(stream, { maxDataLength: MAX_FRAME_BYTES });
  const from = connection.remotePeer.toString();
  try {
    const first = await readHeader(lp);
    if (first.t === "get") {
      await sendOwnPhoto(lp, identity, typeof first.have === "string" ? first.have : null);
    } else if (first.t === "photo" || first.t === "none") {
      // A contact pushing their new photo (or its removal).
      if (!(await isContact(identity, from))) throw new Error("push from non-contact");
      if (first.t === "photo") await setAvatar(from, await readPhoto(lp, first), first.hash);
      else await removeAvatar(from);
      emit(from);
      await writeHeader(lp, { t: "ok" });
    } else {
      throw new Error("bad profile frame");
    }
    await stream.close();
  } catch (err) {
    stream.abort(err instanceof Error ? err : new Error(String(err)));
  }
}

onNodeStart(async (node, identity) => {
  await node.handle(PROFILE_PROTOCOL, (stream, connection) => void handle(stream, connection, identity), {
    runOnLimitedConnection: true,
    maxInboundStreams: 32,
  });
  // Refresh a contact's photo whenever we connect to them.
  node.addEventListener("peer:connect", (e) => {
    const peerId = e.detail.toString();
    if (nodeIds.has(peerId)) return;
    void isContact(identity, peerId).then((yes) => {
      if (yes) void fetchAvatar(identity, peerId);
    });
  });
});

// --------------------------------------------------------------- asking

/** Gets the latest photo of `peerId` from their device (only downloads if it changed). */
export function fetchAvatar(identity: StoredIdentity, peerId: string): Promise<void> {
  if (peerId === identity.peerId) return Promise.resolve();
  const running = inFlight.get(peerId);
  if (running) return running;
  const task = (async () => {
    const nodePromise = getNode();
    if (!nodePromise) return;
    let stream: Stream | undefined;
    try {
      const node = await nodePromise;
      stream = await openPeerStream(node, peerId, PROFILE_PROTOCOL, IO_TIMEOUT_MS);
      const lp = lpStream(stream, { maxDataLength: MAX_FRAME_BYTES });
      const cached = await getProfile(peerId);
      await writeHeader(lp, { t: "get", have: cached?.hash ?? null });
      const reply = await readHeader(lp);
      if (reply.t === "photo") {
        await setAvatar(peerId, await readPhoto(lp, reply), reply.hash);
        emit(peerId);
      } else if (reply.t === "none" && cached) {
        await removeAvatar(peerId);
        emit(peerId);
      }
      await stream.close().catch(() => {});
    } catch {
      stream?.abort(new Error("photo fetch failed"));
    } finally {
      inFlight.delete(peerId);
    }
  })();
  inFlight.set(peerId, task);
  return task;
}

/** After changing your photo: send it to everyone currently connected. */
export async function pushAvatar(identity: StoredIdentity): Promise<void> {
  const node = await getNode()?.catch(() => null);
  if (!node) return;
  const peers = [...new Set(node.getConnections().map((c) => c.remotePeer.toString()))].filter(
    (p) => !nodeIds.has(p) && p !== identity.peerId,
  );
  await Promise.all(
    peers.map(async (peerId) => {
      let stream: Stream | undefined;
      try {
        if (node.getConnections(peerIdFromString(peerId)).length === 0) return;
        stream = await openPeerStream(node, peerId, PROFILE_PROTOCOL, IO_TIMEOUT_MS);
        const lp = lpStream(stream, { maxDataLength: MAX_FRAME_BYTES });
        await sendOwnPhoto(lp, identity, null);
        await readHeader(lp);
        await stream.close().catch(() => {});
      } catch {
        stream?.abort(new Error("photo push failed"));
      }
    }),
  );
}
