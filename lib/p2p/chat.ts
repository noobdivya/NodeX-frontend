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
import { multiaddr } from "@multiformats/multiaddr";
import { addContact, listContacts } from "../contacts";
import { handlesEqual } from "../handle";
import type { StoredIdentity } from "../keystore";
import {
  deleteExpiredMessages,
  getMessage,
  listPending,
  listUnsentReceipts,
  MAX_MESSAGE_LENGTH,
  saveMessage,
  type ChatMessage,
} from "../messages";
import { getNode, lookupHandle, onNodeStart, openPeerStream, peerAddresses, type Node } from "./node";

export const CHAT_PROTOCOL = "/nodex/chat/1.0.0";
const MAX_FRAME_BYTES = 16 * 1024;
const IO_TIMEOUT_MS = 15_000;
const DIAL_TIMEOUT_MS = 20_000;
const OUTBOX_INTERVAL_MS = 15_000;

type MsgFrame = { t: "msg"; id: string; text: string; sent_at: number; from_handle: string };
type ReadFrame = { t: "read"; ids: string[] };
type AckFrame = { t: "ack"; id: string };

const FRAME_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_RECEIPT_IDS = 500;

export type ChatEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "status"; message: ChatMessage }
  | { type: "presence"; peerId: string; online: boolean }
  /** Messages in these conversations disappeared (48 h after being read). */
  | { type: "deleted"; peerIds: string[] };

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
  await node.handle(CHAT_PROTOCOL, (stream, connection) => void receive(stream, connection, identity), {
    runOnLimitedConnection: true,
    maxInboundStreams: 64,
  });

  const presence = (online: boolean) => (e: CustomEvent) => {
    const peerId = e.detail.toString();
    emit({ type: "presence", peerId, online });
    if (online) void flushOutbox(identity, peerId);
  };
  node.addEventListener("peer:connect", presence(true));
  node.addEventListener("peer:disconnect", presence(false));

  const timer = setInterval(() => void flushOutbox(identity), OUTBOX_INTERVAL_MS);
  node.addEventListener("stop", () => clearInterval(timer), { once: true });
  void flushOutbox(identity);
});

function parseFrame<T>(bytes: Uint8Array): T {
  return JSON.parse(dec.decode(bytes)) as T;
}

function isMsgFrame(f: unknown): f is MsgFrame {
  const m = f as MsgFrame;
  return (
    !!m &&
    m.t === "msg" &&
    typeof m.id === "string" &&
    FRAME_ID_RE.test(m.id) &&
    typeof m.text === "string" &&
    m.text.length > 0 &&
    m.text.length <= MAX_MESSAGE_LENGTH &&
    Number.isSafeInteger(m.sent_at) &&
    typeof m.from_handle === "string" &&
    m.from_handle.length <= 64
  );
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

    const id = `${from}:${frame.id}`;
    if (!(await getMessage(id))) {
      const message: ChatMessage = {
        id,
        ownerPeerId: identity.peerId,
        peerId: from,
        direction: "in",
        text: frame.text,
        sentAt: frame.sent_at,
        status: "received",
        read: false,
      };
      await saveMessage(message);
      // People who message you appear in your chats.
      if (!(await listContacts(identity.peerId)).some((c) => c.peerId === from)) {
        await addContact(identity.peerId, { peerId: from, handle });
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
    const frame: MsgFrame = {
      t: "msg",
      id: frameId,
      text: message.text,
      sent_at: message.sentAt,
      from_handle: identity.handle,
    };
    await lp.write(enc.encode(JSON.stringify(frame)), { signal: AbortSignal.timeout(IO_TIMEOUT_MS) });
    const ack = parseFrame<AckFrame>((await lp.read({ signal: AbortSignal.timeout(IO_TIMEOUT_MS) })).subarray());
    if (ack.t !== "ack" || ack.id !== frameId) throw new Error("bad ack");
    await stream.close().catch(() => {});

    // A read receipt may already have arrived; never downgrade ✓✓ to ✓.
    const current = (await getMessage(message.id)) ?? message;
    if (current.status === "pending") {
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

/** One delivery run at a time per conversation; later runs queue behind it. */
const peerQueues = new Map<string, Promise<void>>();

function flushPeer(identity: StoredIdentity, peerId: string): Promise<void> {
  const run = (peerQueues.get(peerId) ?? Promise.resolve()).then(async () => {
    // Re-read inside the queue so messages sent meanwhile are included.
    const queue = (await listPending(identity.peerId)).filter((m) => m.peerId === peerId);
    for (const m of queue) {
      if (!(await deliver(identity, m))) return; // keep order; retry later
    }
    await sendReceipts(identity, peerId);
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
  ]);
  await Promise.all([...peers].map((p) => flushPeer(identity, p)));
}

/** Deletes messages read more than 48 hours ago from this device. */
export async function purgeExpired(identity: StoredIdentity): Promise<void> {
  const changed = await deleteExpiredMessages(identity.peerId);
  if (changed.size > 0) emit({ type: "deleted", peerIds: [...changed] });
}

/** Call after the user has read a conversation: sends the read receipts. */
export function notifyRead(identity: StoredIdentity, peerId: string): void {
  void flushPeer(identity, peerId);
}

/** Saves a new outgoing message (pending) and tries to deliver it right away. */
export async function sendMessage(identity: StoredIdentity, peerId: string, text: string): Promise<ChatMessage> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Message is empty.");
  if (trimmed.length > MAX_MESSAGE_LENGTH) throw new Error(`Messages can be up to ${MAX_MESSAGE_LENGTH} characters.`);
  const message: ChatMessage = {
    id: `${identity.peerId}:${crypto.randomUUID()}`,
    ownerPeerId: identity.peerId,
    peerId,
    direction: "out",
    text: trimmed,
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

/** Whether there's currently a live connection to this peer. */
export async function isConnected(peerId: string): Promise<boolean> {
  const node = await getNode()?.catch(() => null);
  return !!node && node.getConnections(peerIdFromString(peerId)).length > 0;
}

/** Tries to connect to a peer (to show presence and speed up the first message). */
export async function connectTo(peerId: string): Promise<boolean> {
  const node = await getNode()?.catch(() => null);
  if (!node) return false;
  const pid = peerIdFromString(peerId);
  if (node.getConnections(pid).length > 0) return true;
  try {
    await node.dial(
      peerAddresses(peerId).webrtc.map((a) => multiaddr(a)),
      { signal: AbortSignal.timeout(DIAL_TIMEOUT_MS) },
    );
    return true;
  } catch {
    return false;
  }
}
