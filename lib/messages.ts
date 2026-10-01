// Chat messages, stored only on this device (IndexedDB). Each identity on
// the device ("owner") has its own conversations, keyed by the other
// person's Peer ID.
import { STORES, withStore } from "./db";

export const MAX_MESSAGE_LENGTH = 4000;

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
  text: string;
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
};

/** Messages are deleted from this device this long after they were read. */
export const DISAPPEAR_AFTER_READ_MS = 48 * 60 * 60 * 1000;

export type ConversationSummary = { last: ChatMessage; unread: number };

export async function saveMessage(m: ChatMessage): Promise<void> {
  await withStore(STORES.messages, "readwrite", (s) => s.put(m));
}

export async function getMessage(id: string): Promise<ChatMessage | undefined> {
  return withStore(STORES.messages, "readonly", (s) => s.get(id) as IDBRequest<ChatMessage | undefined>);
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
