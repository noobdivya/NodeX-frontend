// Chat messages, stored only on this device (IndexedDB). Each identity on
// the device ("owner") has its own conversations, keyed by the other
// person's Peer ID.
import { STORES, withStore } from "./db";

export const MAX_MESSAGE_LENGTH = 4000;
/** Largest video or document that can be sent. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Files up to this size download automatically; larger ones wait for a tap. */
export const AUTO_DOWNLOAD_BYTES = 5 * 1024 * 1024;
/** Video types browsers can play inline; everything else is a document. */
export const PLAYABLE_VIDEO_TYPES = ["video/mp4", "video/webm", "video/ogg"];

export type ChatFile = {
  name: string;
  /** MIME type as reported by the sender (used only to choose video vs document). */
  type: string;
  size: number;
  /** SHA-256 (hex) of the whole file, checked after download. */
  hash: string;
  blob?: Blob;
};

export const isPlayableVideo = (f: ChatFile) => PLAYABLE_VIDEO_TYPES.includes(f.type);

/** Removes path parts and control characters from a file name and limits its length. */
export function safeFileName(name: string): string {
  const base = name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim();
  return (base || "file").slice(0, 120);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export type MessageStatus =
  /** Outgoing, not yet acknowledged by the recipient's device (queued). */
  | "pending"
  /** Outgoing, the recipient's device confirmed it received it (✓). */
  | "delivered"
  /** Outgoing, the recipient opened the chat and saw it (✓✓). */
  | "read"
  /** Incoming. */
  | "received";

export type ChatMessage = {
  /** Unique per message; the sender's id, prefixed with the sender's Peer ID. */
  id: string;
  ownerPeerId: string;
  /** The other person in the conversation. */
  peerId: string;
  direction: "in" | "out";
  /** Message text, or the caption when `image` is set (may then be empty). */
  text: string;
  /** A photo sent as a message, stored on this device with the message. */
  image?: { blob: Blob; width: number; height: number };
  /**
   * A video or document. The message carries only this description; the
   * bytes are pulled from the sender's device afterwards (`blob` is set on
   * the sender straight away, and on the receiver once downloaded).
   */
  file?: ChatFile;
  /** Sender's clock, ms since epoch. */
  sentAt: number;
  status: MessageStatus;
  /** Incoming messages: whether the owner has seen it. */
  read: boolean;
  /** Incoming messages: whether the sender has been told it was read. */
  receiptSent?: boolean;
  /**
   * When the message was read (incoming: by this user; outgoing: by the
   * recipient, from their read receipt). Messages disappear 48 hours later.
   */
  readAt?: number;
  /** The message this one replies to, with a short copy of it to show as a quote. */
  replyTo?: { id: string; preview: string };
  /** Passed on from another chat. */
  forwarded?: boolean;
  /**
   * Deleted for everyone: the content is gone and only this marker remains
   * ("This message was deleted").
   */
  deleted?: boolean;
  /** Outgoing deleted messages: whether the other device has been told. */
  deleteSent?: boolean;
  /** When the text was last edited (the sender's clock); shown as "edited". */
  editedAt?: number;
  /** Outgoing edited messages: whether the other device has the latest edit. */
  editSent?: boolean;
};

/** Edited outgoing messages whose latest text the other device doesn't have yet. */
export async function listUnsentEdits(ownerPeerId: string, peerId?: string): Promise<ChatMessage[]> {
  const all = await withStore(STORES.messages, "readonly", (s) => s.getAll() as IDBRequest<ChatMessage[]>);
  return all.filter(
    (m) =>
      m.ownerPeerId === ownerPeerId &&
      (!peerId || m.peerId === peerId) &&
      m.direction === "out" &&
      !m.deleted &&
      m.editedAt !== undefined &&
      m.editSent === false,
  );
}

export const MAX_PREVIEW_LENGTH = 120;

/** One line describing a message, for quotes and the chat list. */
export function messagePreview(m: ChatMessage): string {
  if (m.deleted) return m.direction === "out" ? "🚫 You deleted this message" : "🚫 This message was deleted";
  const text = m.image
    ? `📷 ${m.text || "Photo"}`
    : m.file
      ? `${isPlayableVideo(m.file) ? "🎬" : "📄"} ${m.text || m.file.name}`
      : m.text;
  return text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH - 1)}…` : text;
}

/** Messages are deleted from this device this long after they were read. */
export const DISAPPEAR_AFTER_READ_MS = 48 * 60 * 60 * 1000;

export type ConversationSummary = { last: ChatMessage; unread: number };

export async function saveMessage(m: ChatMessage): Promise<void> {
  await withStore(STORES.messages, "readwrite", (s) => s.put(m));
}

export async function getMessage(id: string): Promise<ChatMessage | undefined> {
  return withStore(STORES.messages, "readonly", (s) => s.get(id) as IDBRequest<ChatMessage | undefined>);
}

export async function deleteMessage(id: string): Promise<void> {
  await withStore(STORES.messages, "readwrite", (s) => s.delete(id));
}

/** What's left of a message after it was deleted for everyone. */
export function tombstone(m: ChatMessage, now = Date.now()): ChatMessage {
  return {
    id: m.id,
    ownerPeerId: m.ownerPeerId,
    peerId: m.peerId,
    direction: m.direction,
    text: "",
    sentAt: m.sentAt,
    status: m.status === "pending" ? "delivered" : m.status,
    read: true,
    receiptSent: true,
    // The marker itself disappears 48 hours later.
    readAt: m.readAt ?? now,
    deleted: true,
    ...(m.direction === "out" ? { deleteSent: m.deleteSent ?? false } : {}),
  };
}

/** Deleted outgoing messages the other person's device hasn't been told about yet. */
export async function listUnsentDeletes(ownerPeerId: string, peerId?: string): Promise<ChatMessage[]> {
  const all = await withStore(STORES.messages, "readonly", (s) => s.getAll() as IDBRequest<ChatMessage[]>);
  return all.filter(
    (m) =>
      m.ownerPeerId === ownerPeerId &&
      (!peerId || m.peerId === peerId) &&
      m.direction === "out" &&
      m.deleted &&
      !m.deleteSent,
  );
}

/** A conversation's messages, oldest first. */
export async function listMessages(ownerPeerId: string, peerId: string): Promise<ChatMessage[]> {
  const all = await withStore(
    STORES.messages,
    "readonly",
    (s) => s.index("byConversation").getAll([ownerPeerId, peerId]) as IDBRequest<ChatMessage[]>,
  );
  return all.sort((a, b) => a.sentAt - b.sentAt || (a.id < b.id ? -1 : 1));
}

/** Outgoing messages still waiting for delivery. */
export async function listPending(ownerPeerId: string): Promise<ChatMessage[]> {
  const all = await withStore(
    STORES.messages,
    "readonly",
    (s) => s.index("byStatus").getAll([ownerPeerId, "pending"]) as IDBRequest<ChatMessage[]>,
  );
  return all.sort((a, b) => a.sentAt - b.sentAt);
}

/** Last message and unread count per conversation. */
export async function listConversations(ownerPeerId: string): Promise<Map<string, ConversationSummary>> {
  const all = await withStore(STORES.messages, "readonly", (s) => s.getAll() as IDBRequest<ChatMessage[]>);
  const out = new Map<string, ConversationSummary>();
  for (const m of all) {
    if (m.ownerPeerId !== ownerPeerId) continue;
    const c = out.get(m.peerId);
    const unread = m.direction === "in" && !m.read ? 1 : 0;
    if (!c) out.set(m.peerId, { last: m, unread });
    else {
      c.unread += unread;
      if (m.sentAt >= c.last.sentAt) c.last = m;
    }
  }
  return out;
}

/**
 * Marks a conversation's incoming messages as read: their read receipts
 * become due and their 48-hour disappearing timer starts.
 */
export async function markConversationRead(ownerPeerId: string, peerId: string): Promise<number> {
  const unread = (await listMessages(ownerPeerId, peerId)).filter((m) => m.direction === "in" && !m.read);
  const readAt = Date.now();
  for (const m of unread) await saveMessage({ ...m, read: true, readAt });
  return unread.length;
}

/**
 * Deletes this owner's messages that were read more than 48 hours ago
 * (incoming: read here; outgoing: read by the recipient). Unread messages
 * are kept. Returns the Peer IDs of conversations that changed.
 */
export async function deleteExpiredMessages(ownerPeerId: string, now = Date.now()): Promise<Set<string>> {
  const all = await withStore(STORES.messages, "readonly", (s) => s.getAll() as IDBRequest<ChatMessage[]>);
  const changed = new Set<string>();
  for (const m of all) {
    if (m.ownerPeerId !== ownerPeerId) continue;
    // Read before disappearing messages existed: start their timer now.
    if (m.readAt === undefined && m.direction === "in" && m.read) {
      await saveMessage({ ...m, readAt: now });
      continue;
    }
    if (m.readAt === undefined || now - m.readAt < DISAPPEAR_AFTER_READ_MS) continue;
    // Keep a deletion until the other device has been told about it.
    if (m.deleted && m.direction === "out" && !m.deleteSent) continue;
    await withStore(STORES.messages, "readwrite", (s) => s.delete(m.id));
    changed.add(m.peerId);
  }
  return changed;
}

/** Incoming messages that have been read but whose sender hasn't been told yet. */
export async function listUnsentReceipts(ownerPeerId: string, peerId?: string): Promise<ChatMessage[]> {
  const all = await withStore(STORES.messages, "readonly", (s) => s.getAll() as IDBRequest<ChatMessage[]>);
  return all.filter(
    (m) =>
      m.ownerPeerId === ownerPeerId &&
      (!peerId || m.peerId === peerId) &&
      m.direction === "in" &&
      m.read &&
      !m.receiptSent,
  );
}
