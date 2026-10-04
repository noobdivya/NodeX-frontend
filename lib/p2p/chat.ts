// NodeX chat: one-to-one messages sent directly between two browsers.
//
// Transport: libp2p streams over a direct WebRTC connection (the NodeX
// node's relay only carries the WebRTC handshake), falling back to a relayed
// connection if WebRTC can't be established. Either way the connection is
// end-to-end encrypted and authenticated between the two browsers (Noise),
// so the remote Peer ID is cryptographically proven and relays can't read
// messages. Messages are stored only on the two devices.
//
// Protocol /nodex/chat/1.0.0 — one stream per frame:
//   message:      sender → { t: "msg", id, text, sent_at, from_handle }
//                 receiver → { t: "ack", id }            (saved → sender shows ✓)
//   read receipt: reader → { t: "read", ids: [...] }
//                 original sender → { t: "ack", id: "read" }   (→ sender shows ✓✓)
// Message ids are identical on both devices ("<sender peer id>:<uuid>"), and
// a receipt is only accepted from the peer the messages were sent to.
import type { Connection, Stream } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { lpStream } from "@libp2p/utils";
import { addContact, listContacts, touchLastSeen } from "../contacts";
import { handlesEqual } from "../handle";
import type { StoredIdentity } from "../keystore";
import {
  deleteExpiredMessages,
  deleteMessage,
  getMessage,
  listPending,
  listUnsentDeletes,
  listUnsentEdits,
  listUnsentReceipts,
  MAX_FILE_BYTES,
  MAX_MESSAGE_LENGTH,
  MAX_PREVIEW_LENGTH,
  messagePreview,
  safeFileName,
  saveMessage,
  tombstone,
  type ChatMessage,
} from "../messages";
import { sha256Hex } from "../profile";
import { isBlocked, loadBlocked, storeBlocked } from "./blocklist";
import { connectPeer, getNode, lookupHandle, onNodeStart, openPeerStream, type Node } from "./node";
import { magicMatches } from "./profile-share";

export const CHAT_PROTOCOL = "/nodex/chat/1.0.0";
/** Largest single frame on a chat stream (JSON headers are far smaller; image chunks are ≤ CHUNK_BYTES). */
const MAX_FRAME_BYTES = 96 * 1024;
/** JSON frames (messages, receipts, acks) must stay small. */
const MAX_JSON_BYTES = 16 * 1024;
/** Photos travel after the message header in pieces of this size. */
const CHUNK_BYTES = 60 * 1024;
/** Largest photo accepted from a peer (senders compress to ≤ 1 MB). */
const MAX_IMAGE_BYTES = 1536 * 1024;
const MAX_IMAGE_SIDE = 8000;
const IMAGE_TYPES = ["image/webp", "image/jpeg", "image/png"];
const IO_TIMEOUT_MS = 15_000;
const DIAL_TIMEOUT_MS = 20_000;
const OUTBOX_INTERVAL_MS = 15_000;

type ImageInfo = { type: string; size: number; hash: string; w: number; h: number };
type MsgFrame = {
  t: "msg";
  id: string;
  /** Text, or the caption of `image` (may then be empty). */
  text: string;
  sent_at: number;
  from_handle: string;
  /** Present for photo messages: the bytes follow in chunks. */
  image?: ImageInfo;
  /**
   * Present for videos/documents: only this description is sent here. The
   * receiver pulls the bytes afterwards over /nodex/file/1.0.0.
   */
  file?: FileInfo;
  /** Present when this message replies to an earlier one in the same chat. */
  reply?: ReplyInfo;
  /** Passed on from another chat. */
  fwd?: true;
};
type FileInfo = { name: string; type: string; size: number; hash: string };
/** `mine`: the quoted message was written by the sender of this frame. */
type ReplyInfo = { id: string; mine: boolean; preview: string };
type ReadFrame = { t: "read"; ids: string[] };
/** "Delete for everyone": the sender's own messages to remove on the other device. */
type DelFrame = { t: "del"; ids: string[] };
/** Edits to the sender's own messages; `at` lets the newest edit win. */
type EditFrame = { t: "edit"; items: { id: string; text: string; at: number }[] };
/** "I'm typing": shown for a few seconds, never stored or queued. */
type TypingFrame = { t: "typing" };
type AckFrame = { t: "ack"; id: string };

const MAX_EDITS_PER_FRAME = 50;
/** How long "typing…" stays without a new signal. */
export const TYPING_SHOW_MS = 5_000;
/** At most one typing signal per conversation this often. */
const TYPING_SEND_EVERY_MS = 3_000;

const FRAME_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_RECEIPT_IDS = 500;

export type ChatEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "status"; message: ChatMessage }
  | { type: "presence"; peerId: string; online: boolean }
  /** Messages in these conversations disappeared (48 h after being read). */
  | { type: "deleted"; peerIds: string[] }
  /** This user just read the conversation with `peerId` (unread counts changed). */
  | { type: "read"; peerId: string }
  /** `peerId` is typing a message to this user right now. */
  | { type: "typing"; peerId: string };

const listeners = new Set<(e: ChatEvent) => void>();
export function onChatEvent(listener: (e: ChatEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const emit = (e: ChatEvent) => listeners.forEach((l) => l(e));

const enc = new TextEncoder();
const dec = new TextDecoder();
/** Peer ID → handle, for senders already verified this session. */
const verified = new Map<string, string>();
/** Message ids currently being delivered (avoid duplicate sends). */
const inFlight = new Set<string>();

// ---------------------------------------------------------------- receiving

onNodeStart(async (node, identity) => {
  await loadBlocked(identity.peerId);
  await node.handle(CHAT_PROTOCOL, (stream, connection) => void receive(stream, connection, identity), {
    runOnLimitedConnection: true,
    maxInboundStreams: 64,
  });

  const presence = (online: boolean) => (e: CustomEvent) => {
    const peerId = e.detail.toString();
    // "Last seen" is what this device observed itself: when it was last connected to them.
    void touchLastSeen(identity.peerId, peerId).catch(() => {});
    emit({ type: "presence", peerId, online });
    if (online) void flushOutbox(identity, peerId);
  };
  node.addEventListener("peer:connect", presence(true));
  node.addEventListener("peer:disconnect", presence(false));

  const timer = setInterval(() => {
    void flushOutbox(identity);
    // Keep "last seen" fresh for contacts that are connected right now.
    for (const p of node.getPeers()) void touchLastSeen(identity.peerId, p.toString()).catch(() => {});
  }, OUTBOX_INTERVAL_MS);
  node.addEventListener("stop", () => clearInterval(timer), { once: true });
  void flushOutbox(identity);
});

function parseFrame<T>(bytes: Uint8Array): T {
  if (bytes.length > MAX_JSON_BYTES) throw new Error("frame too large");
  return JSON.parse(dec.decode(bytes)) as T;
}

function isImageInfo(i: unknown): i is ImageInfo {
  const x = i as ImageInfo;
  return (
    !!x &&
    typeof x.type === "string" &&
    IMAGE_TYPES.includes(x.type) &&
    Number.isSafeInteger(x.size) &&
    x.size > 0 &&
    x.size <= MAX_IMAGE_BYTES &&
    typeof x.hash === "string" &&
    /^[0-9a-f]{64}$/.test(x.hash) &&
    Number.isSafeInteger(x.w) &&
    Number.isSafeInteger(x.h) &&
    x.w > 0 &&
    x.h > 0 &&
    x.w <= MAX_IMAGE_SIDE &&
    x.h <= MAX_IMAGE_SIDE
  );
}

function isFileInfo(f: unknown): f is FileInfo {
  const x = f as FileInfo;
  return (
    !!x &&
    typeof x.name === "string" &&
    x.name.length > 0 &&
    x.name.length <= 255 &&
    typeof x.type === "string" &&
    x.type.length <= 127 &&
    Number.isSafeInteger(x.size) &&
    x.size > 0 &&
    x.size <= MAX_FILE_BYTES &&
    typeof x.hash === "string" &&
    /^[0-9a-f]{64}$/.test(x.hash)
  );
}

/** Reads the chunks of a photo that follow its header, and checks it is what the header claims. */
async function readImage(lp: ReturnType<typeof lpStream>, info: ImageInfo): Promise<Blob> {
  const bytes = new Uint8Array(info.size);
  let got = 0;
  while (got < info.size) {
    const chunk = (await lp.read({ signal: AbortSignal.timeout(IO_TIMEOUT_MS) })).subarray();
    if (chunk.length === 0 || got + chunk.length > info.size) throw new Error("bad image chunk");
    bytes.set(chunk, got);
    got += chunk.length;
  }
  if (!magicMatches(info.type, bytes)) throw new Error("not a real image");
  if ((await sha256Hex(bytes)) !== info.hash) throw new Error("image hash mismatch");
  return new Blob([bytes], { type: info.type });
}

function isMsgFrame(f: unknown): f is MsgFrame {
  const m = f as MsgFrame;
  return (
    !!m &&
    m.t === "msg" &&
    typeof m.id === "string" &&
    FRAME_ID_RE.test(m.id) &&
    typeof m.text === "string" &&
    m.text.length <= MAX_MESSAGE_LENGTH &&
    Number.isSafeInteger(m.sent_at) &&
    typeof m.from_handle === "string" &&
    m.from_handle.length <= 64 &&
    // Text, or a photo, or a file (the latter two with an optional caption).
    !(m.image !== undefined && m.file !== undefined) &&
    (m.image !== undefined
      ? isImageInfo(m.image)
      : m.file !== undefined
        ? isFileInfo(m.file)
        : m.text.length > 0) &&
    (m.reply === undefined || isReplyInfo(m.reply)) &&
    (m.fwd === undefined || m.fwd === true)
  );
}

function isReplyInfo(r: unknown): r is ReplyInfo {
  const x = r as ReplyInfo;
  return (
    !!x &&
    typeof x.id === "string" &&
    FRAME_ID_RE.test(x.id) &&
    typeof x.mine === "boolean" &&
    typeof x.preview === "string" &&
    x.preview.length <= MAX_PREVIEW_LENGTH
  );
}

function isEditFrame(f: unknown): f is EditFrame {
  const e = f as EditFrame;
  return (
    !!e &&
    e.t === "edit" &&
    Array.isArray(e.items) &&
    e.items.length > 0 &&
    e.items.length <= MAX_EDITS_PER_FRAME &&
    e.items.every(
      (i) =>
        !!i &&
        typeof i.id === "string" &&
        FRAME_ID_RE.test(i.id) &&
        typeof i.text === "string" &&
        i.text.length <= MAX_MESSAGE_LENGTH &&
        Number.isSafeInteger(i.at),
    )
  );
}

/**
 * Applies edits from `from`: only messages `from` wrote themselves can be
 * changed, deleted messages stay deleted, and an older edit never replaces
 * a newer one.
 */
async function applyEdits(identity: StoredIdentity, from: string, frame: EditFrame) {
  for (const item of frame.items) {
    const m = await getMessage(`${from}:${item.id}`);
    if (!m || m.ownerPeerId !== identity.peerId || m.direction !== "in" || m.peerId !== from || m.deleted) continue;
    if ((m.editedAt ?? 0) >= item.at) continue;
    const text = item.text.trim();
    if (!text && !m.image && !m.file) continue; // a text message can't become empty
    const edited: ChatMessage = { ...m, text, editedAt: item.at };
    await saveMessage(edited);
    emit({ type: "status", message: edited });
  }
}

function isDelFrame(f: unknown): f is DelFrame {
  const d = f as DelFrame;
  return (
    !!d &&
    d.t === "del" &&
    Array.isArray(d.ids) &&
    d.ids.length > 0 &&
    d.ids.length <= MAX_RECEIPT_IDS &&
    d.ids.every((id) => typeof id === "string" && FRAME_ID_RE.test(id))
  );
}

/**
 * Applies "delete for everyone" from `from`: only messages that `from`
 * wrote themselves (their ids start with their Peer ID) can be removed.
 */
async function applyDelete(identity: StoredIdentity, from: string, frame: DelFrame) {
  for (const frameId of frame.ids) {
    const m = await getMessage(`${from}:${frameId}`);
    if (!m || m.ownerPeerId !== identity.peerId || m.direction !== "in" || m.peerId !== from || m.deleted) continue;
    const gone = tombstone(m);
    await saveMessage(gone);
    emit({ type: "status", message: gone });
  }
}

function isReadFrame(f: unknown): f is ReadFrame {
  const r = f as ReadFrame;
  return (
    !!r &&
    r.t === "read" &&
    Array.isArray(r.ids) &&
    r.ids.length > 0 &&
    r.ids.length <= MAX_RECEIPT_IDS &&
    r.ids.every((id) => typeof id === "string" && FRAME_ID_RE.test(id))
  );
}

/**
 * Applies a read receipt from `from`: only this owner's outgoing messages
 * that were sent to `from` can be marked read.
 */
async function applyReadReceipt(identity: StoredIdentity, from: string, frame: ReadFrame) {
  const readAt = Date.now();
  for (const frameId of frame.ids) {
    const m = await getMessage(`${identity.peerId}:${frameId}`);
    if (!m || m.ownerPeerId !== identity.peerId || m.direction !== "out" || m.peerId !== from) continue;
    if (m.status === "read") continue;
    const updated: ChatMessage = { ...m, status: "read", readAt };
    await saveMessage(updated);
    emit({ type: "status", message: updated });
  }
}

/**
 * Confirms that `claimedHandle` really belongs to `peerId` — from contacts,
 * or by looking the handle up in the DHT and checking its signed record.
 */
async function verifySender(identity: StoredIdentity, peerId: string, claimedHandle: string): Promise<string | null> {
  const cached = verified.get(peerId);
  if (cached) return cached;
  const contact = (await listContacts(identity.peerId)).find((c) => c.peerId === peerId);
  if (contact) {
    verified.set(peerId, contact.handle);
    return contact.handle;
  }
  try {
    const found = await lookupHandle(identity, claimedHandle);
    if (found && found.peerId === peerId && handlesEqual(found.handle, claimedHandle)) {
      verified.set(peerId, found.handle);
      return found.handle;
    }
  } catch {
    // treated as unverified
  }
  return null;
}

async function receive(stream: Stream, connection: Connection, identity: StoredIdentity) {
  const lp = lpStream(stream, { maxDataLength: MAX_FRAME_BYTES });
  try {
    const frame = parseFrame<unknown>((await lp.read({ signal: AbortSignal.timeout(IO_TIMEOUT_MS) })).subarray());
    // The connection is authenticated: remotePeer is cryptographically proven.
    const from = connection.remotePeer.toString();
    // Nothing is accepted from someone this user blocked; they get no reply.
    if (isBlocked(from)) throw new Error("blocked");
    void touchLastSeen(identity.peerId, from).catch(() => {});

    if ((frame as TypingFrame)?.t === "typing") {
      emit({ type: "typing", peerId: from });
      await stream.close();
      return;
    }
    if (isEditFrame(frame)) {
      await applyEdits(identity, from, frame);
      await lp.write(enc.encode(JSON.stringify({ t: "ack", id: "edit" } satisfies AckFrame)), {
        signal: AbortSignal.timeout(IO_TIMEOUT_MS),
      });
      await stream.close();
      return;
    }
    if (isDelFrame(frame)) {
      await applyDelete(identity, from, frame);
      await lp.write(enc.encode(JSON.stringify({ t: "ack", id: "del" } satisfies AckFrame)), {
        signal: AbortSignal.timeout(IO_TIMEOUT_MS),
      });
      await stream.close();
      return;
    }
    if (isReadFrame(frame)) {
      await applyReadReceipt(identity, from, frame);
      await lp.write(enc.encode(JSON.stringify({ t: "ack", id: "read" } satisfies AckFrame)), {
        signal: AbortSignal.timeout(IO_TIMEOUT_MS),
      });
      await stream.close();
      return;
    }
    if (!isMsgFrame(frame)) throw new Error("bad chat frame");

    const handle = await verifySender(identity, from, frame.from_handle);
    if (!handle) throw new Error("could not verify sender's handle");

    // A photo's bytes follow the header. Always read them (even for a
    // duplicate), so the sender's writes complete and it gets its ack.
    const imageBlob = frame.image ? await readImage(lp, frame.image) : undefined;

    const id = `${from}:${frame.id}`;
    if (!(await getMessage(id))) {
      const message: ChatMessage = {
        id,
        ownerPeerId: identity.peerId,
        peerId: from,
        direction: "in",
        text: frame.text,
        ...(frame.image && imageBlob
          ? { image: { blob: imageBlob, width: frame.image.w, height: frame.image.h } }
          : {}),
        // File bytes are not here yet; they are downloaded from the sender afterwards.
        ...(frame.file
          ? {
              file: {
                name: safeFileName(frame.file.name),
                type: frame.file.type,
                size: frame.file.size,
                hash: frame.file.hash,
              },
            }
          : {}),
        // The quoted message has the same id on both devices: "<its writer>:<uuid>".
        ...(frame.reply
          ? {
              replyTo: {
                id: `${frame.reply.mine ? from : identity.peerId}:${frame.reply.id}`,
                preview: frame.reply.preview,
              },
            }
          : {}),
        ...(frame.fwd ? { forwarded: true } : {}),
        sentAt: frame.sent_at,
        status: "received",
        read: false,
      };
      await saveMessage(message);
      // People who message you appear in your chats.
      if (!(await listContacts(identity.peerId)).some((c) => c.peerId === from)) {
        await addContact(identity.peerId, { peerId: from, handle, auto: true });
      }
      emit({ type: "message", message });
    }
    // Acknowledge (also for duplicates, so the sender stops retrying).
    await lp.write(enc.encode(JSON.stringify({ t: "ack", id: frame.id } satisfies AckFrame)), {
      signal: AbortSignal.timeout(IO_TIMEOUT_MS),
    });
    await stream.close();
  } catch (err) {
    stream.abort(err instanceof Error ? err : new Error(String(err)));
  }
}

// ------------------------------------------------------------------ sending

/** Opens a chat stream to a peer: existing connection, else WebRTC via relay, else relayed. */
function openStream(node: Node, peerId: string): Promise<Stream> {
  return openPeerStream(node, peerId, CHAT_PROTOCOL, DIAL_TIMEOUT_MS);
}

/** Tries to deliver one message; true once the recipient acknowledged it. */
async function deliver(identity: StoredIdentity, message: ChatMessage): Promise<boolean> {
  if (inFlight.has(message.id)) return false;
  const nodePromise = getNode();
  if (!nodePromise) return false;
  inFlight.add(message.id);
  let stream: Stream | undefined;
  try {
    const node = await nodePromise;
    stream = await openStream(node, message.peerId);
    const lp = lpStream(stream, { maxDataLength: MAX_FRAME_BYTES });
    const frameId = message.id.slice(message.id.indexOf(":") + 1);
    const imageBytes = message.image ? new Uint8Array(await message.image.blob.arrayBuffer()) : undefined;
    const frame: MsgFrame = {
      t: "msg",
      id: frameId,
      text: message.text,
      sent_at: message.sentAt,
      from_handle: identity.handle,
      ...(message.image && imageBytes
        ? {
            image: {
              type: message.image.blob.type,
              size: imageBytes.length,
              hash: await sha256Hex(imageBytes),
              w: message.image.width,
              h: message.image.height,
            },
          }
        : {}),
      ...(message.file
        ? {
            file: {
              name: message.file.name,
              type: message.file.type,
              size: message.file.size,
              hash: message.file.hash,
            },
          }
        : {}),
      ...(message.replyTo
        ? {
            reply: {
              id: message.replyTo.id.slice(message.replyTo.id.indexOf(":") + 1),
              mine: message.replyTo.id.startsWith(`${identity.peerId}:`),
              preview: message.replyTo.preview,
            },
          }
        : {}),
      ...(message.forwarded ? { fwd: true as const } : {}),
    };
    await lp.write(enc.encode(JSON.stringify(frame)), { signal: AbortSignal.timeout(IO_TIMEOUT_MS) });
    // Photo bytes follow the header in chunks.
    if (imageBytes) {
      for (let off = 0; off < imageBytes.length; off += CHUNK_BYTES) {
        await lp.write(imageBytes.subarray(off, off + CHUNK_BYTES), { signal: AbortSignal.timeout(IO_TIMEOUT_MS) });
      }
    }
    // The receiver verifies the sender and (for photos) the whole image before acking.
    const ackTimeout = imageBytes ? IO_TIMEOUT_MS * 3 : IO_TIMEOUT_MS;
    const ack = parseFrame<AckFrame>((await lp.read({ signal: AbortSignal.timeout(ackTimeout) })).subarray());
    if (ack.t !== "ack" || ack.id !== frameId) throw new Error("bad ack");
    await stream.close().catch(() => {});

    // A read receipt may already have arrived; never downgrade ✓✓ to ✓.
    const current = await getMessage(message.id);
    if (!current) {
      // Deleted here while it was on its way: make sure the other device removes it too.
      await saveMessage(tombstone(message));
    } else if (current.status === "pending") {
      const delivered: ChatMessage = { ...current, status: "delivered" };
      await saveMessage(delivered);
      emit({ type: "status", message: delivered });
    }
    return true;
  } catch {
    stream?.abort(new Error("delivery failed"));
    return false;
  } finally {
    inFlight.delete(message.id);
  }
}

/** Tells `peerId` which of their messages this user has read; true once acknowledged. */
async function sendReceipts(identity: StoredIdentity, peerId: string): Promise<boolean> {
  const due = await listUnsentReceipts(identity.peerId, peerId);
  if (due.length === 0) return true;
  const nodePromise = getNode();
  if (!nodePromise) return false;
  let stream: Stream | undefined;
  try {
    const node = await nodePromise;
    stream = await openStream(node, peerId);
    const lp = lpStream(stream, { maxDataLength: MAX_FRAME_BYTES });
    const batch = due.slice(0, MAX_RECEIPT_IDS);
    const frame: ReadFrame = { t: "read", ids: batch.map((m) => m.id.slice(m.id.indexOf(":") + 1)) };
    await lp.write(enc.encode(JSON.stringify(frame)), { signal: AbortSignal.timeout(IO_TIMEOUT_MS) });
    const ack = parseFrame<AckFrame>((await lp.read({ signal: AbortSignal.timeout(IO_TIMEOUT_MS) })).subarray());
    if (ack.t !== "ack" || ack.id !== "read") throw new Error("bad receipt ack");
    await stream.close().catch(() => {});
    for (const m of batch) {
      const current = (await getMessage(m.id)) ?? m;
      await saveMessage({ ...current, receiptSent: true });
    }
    return batch.length === due.length;
  } catch {
    stream?.abort(new Error("receipt failed"));
    return false;
  }
}

/** Tells `peerId` which of this user's messages were deleted for everyone; true once acknowledged. */
/** Sends this user's edits that `peerId` hasn't received yet; true once acknowledged. */
async function sendEdits(identity: StoredIdentity, peerId: string): Promise<boolean> {
  const due = await listUnsentEdits(identity.peerId, peerId);
  if (due.length === 0) return true;
  const nodePromise = getNode();
  if (!nodePromise) return false;
  let stream: Stream | undefined;
  try {
    const node = await nodePromise;
    stream = await openStream(node, peerId);
    const lp = lpStream(stream, { maxDataLength: MAX_FRAME_BYTES });
    // Long texts make big frames: send a few at a time.
    const batch: ChatMessage[] = [];
    let bytes = 0;
    for (const m of due) {
      if (batch.length >= MAX_EDITS_PER_FRAME || bytes + m.text.length * 4 > MAX_JSON_BYTES - 1024) break;
      batch.push(m);
      bytes += m.text.length * 4 + 100;
    }
    const frame: EditFrame = {
      t: "edit",
      items: batch.map((m) => ({ id: m.id.slice(m.id.indexOf(":") + 1), text: m.text, at: m.editedAt! })),
    };
    await lp.write(enc.encode(JSON.stringify(frame)), { signal: AbortSignal.timeout(IO_TIMEOUT_MS) });
    const ack = parseFrame<AckFrame>((await lp.read({ signal: AbortSignal.timeout(IO_TIMEOUT_MS) })).subarray());
    if (ack.t !== "ack" || ack.id !== "edit") throw new Error("bad edit ack");
    await stream.close().catch(() => {});
    for (const m of batch) {
      const current = await getMessage(m.id);
      // Only mark it sent if it wasn't edited again meanwhile.
      if (current && current.editedAt === m.editedAt) await saveMessage({ ...current, editSent: true });
    }
    return batch.length === due.length;
  } catch {
    stream?.abort(new Error("edit failed"));
    return false;
  }
}

async function sendDeletes(identity: StoredIdentity, peerId: string): Promise<boolean> {
  const due = await listUnsentDeletes(identity.peerId, peerId);
  if (due.length === 0) return true;
  const nodePromise = getNode();
  if (!nodePromise) return false;
  let stream: Stream | undefined;
  try {
    const node = await nodePromise;
    stream = await openStream(node, peerId);
    const lp = lpStream(stream, { maxDataLength: MAX_FRAME_BYTES });
    const batch = due.slice(0, MAX_RECEIPT_IDS);
    const frame: DelFrame = { t: "del", ids: batch.map((m) => m.id.slice(m.id.indexOf(":") + 1)) };
    await lp.write(enc.encode(JSON.stringify(frame)), { signal: AbortSignal.timeout(IO_TIMEOUT_MS) });
    const ack = parseFrame<AckFrame>((await lp.read({ signal: AbortSignal.timeout(IO_TIMEOUT_MS) })).subarray());
    if (ack.t !== "ack" || ack.id !== "del") throw new Error("bad delete ack");
    await stream.close().catch(() => {});
    for (const m of batch) {
      const current = await getMessage(m.id);
      if (current) await saveMessage({ ...current, deleteSent: true });
    }
    return batch.length === due.length;
  } catch {
    stream?.abort(new Error("delete failed"));
    return false;
  }
}

/** One delivery run at a time per conversation; later runs queue behind it. */
const peerQueues = new Map<string, Promise<void>>();

function flushPeer(identity: StoredIdentity, peerId: string): Promise<void> {
  const run = (peerQueues.get(peerId) ?? Promise.resolve()).then(async () => {
    if (isBlocked(peerId)) return;
    // Re-read inside the queue so messages sent meanwhile are included.
    const queue = (await listPending(identity.peerId)).filter((m) => m.peerId === peerId);
    for (const queued of queue) {
      // Re-read: it may have been deleted or edited while waiting.
      const m = await getMessage(queued.id);
      if (!m || m.status !== "pending") continue;
      if (!(await deliver(identity, m))) return; // keep order; retry later
    }
    await sendReceipts(identity, peerId);
    await sendEdits(identity, peerId);
    await sendDeletes(identity, peerId);
  });
  const settled = run.catch(() => {});
  peerQueues.set(peerId, settled);
  void settled.then(() => {
    if (peerQueues.get(peerId) === settled) peerQueues.delete(peerId);
  });
  return settled;
}

/** Retries queued messages and read receipts (optionally only for one peer). */
async function flushOutbox(identity: StoredIdentity, onlyPeer?: string) {
  if (onlyPeer) return flushPeer(identity, onlyPeer);
  const peers = new Set([
    ...(await listPending(identity.peerId)).map((m) => m.peerId),
    ...(await listUnsentReceipts(identity.peerId)).map((m) => m.peerId),
    ...(await listUnsentDeletes(identity.peerId)).map((m) => m.peerId),
    ...(await listUnsentEdits(identity.peerId)).map((m) => m.peerId),
  ]);
  await Promise.all([...peers].map((p) => flushPeer(identity, p)));
}

/** Tells the screens a stored message changed (e.g. its file finished downloading). */
export function notifyMessageUpdated(message: ChatMessage): void {
  emit({ type: "status", message });
}

/** Deletes messages read more than 48 hours ago from this device. */
export async function purgeExpired(identity: StoredIdentity): Promise<void> {
  const changed = await deleteExpiredMessages(identity.peerId);
  if (changed.size > 0) emit({ type: "deleted", peerIds: [...changed] });
}

/** Call after the user has read a conversation: sends the read receipts. */
export function notifyRead(identity: StoredIdentity, peerId: string): void {
  emit({ type: "read", peerId });
  void flushPeer(identity, peerId);
}

/**
 * Saves a new outgoing message (pending) and tries to deliver it right away.
 * With `image`, `text` is its optional caption.
 */
export async function sendMessage(
  identity: StoredIdentity,
  peerId: string,
  text: string,
  image?: ChatMessage["image"],
  file?: ChatMessage["file"],
  extra: { replyTo?: ChatMessage; forwarded?: boolean } = {},
): Promise<ChatMessage> {
  const trimmed = text.trim();
  if (isBlocked(peerId)) throw new Error("You blocked this contact. Unblock them to send messages.");
  if (!trimmed && !image && !file) throw new Error("Message is empty.");
  if (trimmed.length > MAX_MESSAGE_LENGTH) throw new Error(`Messages can be up to ${MAX_MESSAGE_LENGTH} characters.`);
  if (image && (!IMAGE_TYPES.includes(image.blob.type) || image.blob.size > MAX_IMAGE_BYTES)) {
    throw new Error("That photo can't be sent. Try another one.");
  }
  if (file && (!file.blob || file.size <= 0 || file.size > MAX_FILE_BYTES)) {
    throw new Error("That file can't be sent.");
  }
  const message: ChatMessage = {
    id: `${identity.peerId}:${crypto.randomUUID()}`,
    ownerPeerId: identity.peerId,
    peerId,
    direction: "out",
    text: trimmed,
    ...(image ? { image } : {}),
    ...(file ? { file } : {}),
    ...(extra.replyTo ? { replyTo: { id: extra.replyTo.id, preview: messagePreview(extra.replyTo) } } : {}),
    ...(extra.forwarded ? { forwarded: true } : {}),
    sentAt: Date.now(),
    status: "pending",
    read: true,
  };
  await saveMessage(message);
  emit({ type: "message", message });
  // Deliver after earlier queued messages to this person, to keep order.
  void flushOutbox(identity, peerId);
  return message;
}

/** Removes a message from this device only. The other person keeps their copy. */
export async function deleteForMe(message: ChatMessage): Promise<void> {
  await deleteMessage(message.id);
  emit({ type: "deleted", peerIds: [message.peerId] });
}

/**
 * Removes one of this user's own messages from both devices. The other
 * device is told directly; if it's offline, as soon as it's reachable.
 */
/**
 * Changes the text (or caption) of one of this user's messages on both
 * devices. A message still waiting on this device is simply changed; a
 * delivered one is marked "edited" and the change is sent to the other
 * device (now, or as soon as it's reachable).
 */
export async function editMessage(identity: StoredIdentity, message: ChatMessage, newText: string): Promise<void> {
  if (message.direction !== "out" || message.ownerPeerId !== identity.peerId) return;
  const current = await getMessage(message.id);
  if (!current || current.deleted) throw new Error("This message can no longer be edited.");
  const text = newText.trim();
  if (text.length > MAX_MESSAGE_LENGTH) throw new Error(`Messages can be up to ${MAX_MESSAGE_LENGTH} characters.`);
  if (!text && !current.image && !current.file) throw new Error("A message can't be empty. Delete it instead.");
  if (text === current.text) return;
  const updated: ChatMessage =
    current.status === "pending" && !inFlight.has(current.id)
      ? { ...current, text }
      : { ...current, text, editedAt: Math.max(Date.now(), (current.editedAt ?? 0) + 1), editSent: false };
  await saveMessage(updated);
  emit({ type: "status", message: updated });
  void flushOutbox(identity, message.peerId);
}

const lastTypingSent = new Map<string, number>();

/**
 * Tells `peerId` that this user is typing. Only over a connection that's
 * already open, at most every few seconds, and never stored or queued.
 */
export async function sendTyping(peerId: string): Promise<void> {
  const now = Date.now();
  if (isBlocked(peerId) || now - (lastTypingSent.get(peerId) ?? 0) < TYPING_SEND_EVERY_MS) return;
  const node = await getNode()?.catch(() => null);
  if (!node || node.getConnections(peerIdFromString(peerId)).length === 0) return;
  lastTypingSent.set(peerId, now);
  let stream: Stream | undefined;
  try {
    stream = await openStream(node, peerId);
    const lp = lpStream(stream, { maxDataLength: MAX_FRAME_BYTES });
    await lp.write(enc.encode(JSON.stringify({ t: "typing" } satisfies TypingFrame)), {
      signal: AbortSignal.timeout(IO_TIMEOUT_MS),
    });
    await stream.close().catch(() => {});
  } catch {
    stream?.abort(new Error("typing signal failed"));
  }
}

/** Call after sending, so the next keystroke signals "typing" again straight away. */
export function resetTyping(peerId: string): void {
  lastTypingSent.delete(peerId);
}

export async function deleteForEveryone(identity: StoredIdentity, message: ChatMessage): Promise<void> {
  if (message.direction !== "out" || message.ownerPeerId !== identity.peerId) return;
  if (message.status === "pending" && !inFlight.has(message.id)) {
    // Never left this device: nothing to tell anyone.
    await deleteForMe(message);
    return;
  }
  const gone = tombstone(message);
  await saveMessage(gone);
  emit({ type: "status", message: gone });
  void flushOutbox(identity, message.peerId);
}

/**
 * Blocks or unblocks a contact. Blocking closes any connection to them and
 * from then on this device refuses theirs; they are not told. Unblocking
 * sends whatever was waiting for them.
 */
export async function setBlocked(identity: StoredIdentity, peerId: string, blocked: boolean): Promise<void> {
  await storeBlocked(identity.peerId, peerId, blocked);
  if (blocked) {
    const node = await getNode()?.catch(() => null);
    await node?.hangUp(peerIdFromString(peerId)).catch(() => {});
    emit({ type: "presence", peerId, online: false });
  } else {
    void flushOutbox(identity, peerId);
  }
}

/** Whether there's currently a live connection to this peer. */
export async function isConnected(peerId: string): Promise<boolean> {
  const node = await getNode()?.catch(() => null);
  return !!node && node.getConnections(peerIdFromString(peerId)).length > 0;
}

/** Tries to connect to a peer (to show presence and speed up the first message). */
export async function connectTo(peerId: string): Promise<boolean> {
  const node = await getNode()?.catch(() => null);
  if (!node || isBlocked(peerId)) return false;
  try {
    await connectPeer(node, peerId, DIAL_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}
