"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { addContact, getContact, listContacts, type Contact } from "@/lib/contacts";
import type { StoredIdentity } from "@/lib/keystore";
import type { ChatImage } from "@/lib/image";
import {
  formatBytes,
  listMessages,
  markConversationRead,
  MAX_FILE_BYTES,
  MAX_MESSAGE_LENGTH,
  messagePreview,
  safeFileName,
  type ChatMessage,
} from "@/lib/messages";
import type { NetworkStatus } from "@/lib/p2p/node";
import Avatar from "./Avatar";
import EmojiPicker, { isJumboEmoji } from "./EmojiPicker";
import FileAttachment from "./FileAttachment";
import { AttachIcon, BackIcon, CheckIcon, ClockIcon, CloseIcon, DoubleCheckIcon, MoreIcon, SendIcon } from "./icons";

/** 🕓 waiting · ✓ delivered · ✓✓ read */
export function MessageTick({ status, size = 14 }: { status: ChatMessage["status"]; size?: number }) {
  if (status === "read") {
    return (
      <span className="tick tick-read" aria-label="Read" title="Read">
        <DoubleCheckIcon size={size + 2} />
      </span>
    );
  }
  if (status === "delivered") {
    return (
      <span className="tick" aria-label="Delivered" title="Delivered">
        <CheckIcon size={size} />
      </span>
    );
  }
  return (
    <span className="tick" aria-label="Waiting to be delivered" title="Waiting to be delivered">
      <ClockIcon size={size - 1} />
    </span>
  );
}

/** Object URL for a Blob, revoked when it changes or the component unmounts. */
function useBlobUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/** A photo inside a message bubble; tap to view it full screen. */
function MessagePhoto({
  image,
  alt,
  onOpen,
}: {
  image: NonNullable<ChatMessage["image"]>;
  alt: string;
  onOpen: (url: string) => void;
}) {
  const url = useBlobUrl(image.blob);
  // Reserve the right shape before the image loads, so the chat doesn't jump.
  const ratio = image.width / image.height;
  return (
    <button
      type="button"
      className="bubble-photo"
      style={{ aspectRatio: String(ratio), width: Math.min(280, Math.max(140, Math.round(240 * ratio))) }}
      aria-label={`Open photo${alt ? `: ${alt}` : ""}`}
      onClick={() => url && onOpen(url)}
    >
      {url && <img src={url} alt={alt || "Photo"} />}
    </button>
  );
}

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "last seen today at 11:05", from when this device was last connected to them. */
function lastSeenLabel(ms: number): string {
  const d = new Date(ms);
  const time = timeLabel(ms);
  if (d.toDateString() === new Date().toDateString()) return `last seen today at ${time}`;
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return `last seen yesterday at ${time}`;
  return `last seen ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} at ${time}`;
}

/** One-to-one chat, delivered directly peer to peer. */
export default function ChatScreen({
  identity,
  contact,
  avatarUrl,
  network,
  onBack,
}: {
  identity: StoredIdentity;
  contact: Contact;
  /** The contact's profile photo, if received. */
  avatarUrl?: string;
  network: NetworkStatus;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [presence, setPresence] = useState<"online" | "connecting" | "offline">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** A photo chosen but not yet sent (the text box becomes its caption). */
  const [photo, setPhoto] = useState<ChatImage | null>(null);
  /** A video or document chosen but not yet sent. */
  const [doc, setDoc] = useState<File | null>(null);
  const [preparing, setPreparing] = useState(false);
  /** Photo currently opened full screen. */
  const [viewer, setViewer] = useState<string | null>(null);
  /** When this device was last connected to them. */
  const [lastSeen, setLastSeen] = useState<number | undefined>(contact.lastSeen);
  /** The message being replied to. */
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  /** The message whose actions (reply, forward, delete) are open. */
  const [actionFor, setActionFor] = useState<ChatMessage | null>(null);
  /** The message being forwarded, while choosing who to send it to. */
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null);
  const [forwardTargets, setForwardTargets] = useState<Contact[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  /** Whether this user has blocked the contact. */
  const [blocked, setBlocked] = useState(!!contact.blocked);
  const [headMenu, setHeadMenu] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  /** One of the user's own messages being edited in the message box. */
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  /** They are typing to this user right now. */
  const [typing, setTyping] = useState(false);
  /** They messaged this user but weren't saved as a contact. */
  const [unsaved, setUnsaved] = useState(!!contact.auto);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const photoUrl = useBlobUrl(photo?.blob);

  /**
   * Attaches a chosen or pasted file. Images become photos (resized and
   * compressed on this device); anything else is a video or document, sent
   * as-is and downloaded by the other person straight from this device.
   */
  async function attach(file: Blob | undefined | null) {
    if (!file) return;
    setError(null);
    if (!file.type.startsWith("image/")) {
      if (file.size === 0) {
        setError("That file is empty.");
      } else if (file.size > MAX_FILE_BYTES) {
        setError(`That file is too large. The limit is ${formatBytes(MAX_FILE_BYTES)}.`);
      } else {
        setPhoto(null);
        setDoc(file instanceof File ? file : new File([file], "file", { type: file.type }));
        inputRef.current?.focus();
      }
      return;
    }
    setPreparing(true);
    try {
      const { toChatImage } = await import("@/lib/image");
      setDoc(null);
      setPhoto(await toChatImage(file));
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't use that photo. Try another one.");
    } finally {
      setPreparing(false);
    }
  }

  /** Inserts an emoji at the cursor (replacing any selection) and keeps typing there. */
  function insertEmoji(emoji: string) {
    const el = inputRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    if (next.length > MAX_MESSAGE_LENGTH) return;
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  // Load history, mark as read, and follow live events.
  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    (async () => {
      const chat = await import("@/lib/p2p/chat");
      await chat.purgeExpired(identity);
      if (!alive) return;
      setMessages(await listMessages(identity.peerId, contact.peerId));
      // Opening the chat reads it: start the 48 h timer and send read receipts.
      await markConversationRead(identity.peerId, contact.peerId);
      chat.notifyRead(identity, contact.peerId);
      if (!alive) return;
      void getContact(identity.peerId, contact.peerId).then((c) => {
        if (!alive || !c) return;
        if (c.lastSeen) setLastSeen(c.lastSeen);
        setBlocked(!!c.blocked);
        setUnsaved(!!c.auto);
      });
      unsubscribe = chat.onChatEvent((e) => {
        if (e.type === "presence") {
          if (e.peerId === contact.peerId) {
            setPresence(e.online ? "online" : "offline");
            setLastSeen(Date.now());
            if (!e.online) setTyping(false);
          }
          return;
        }
        if (e.type === "typing") {
          if (e.peerId !== contact.peerId) return;
          setTyping(true);
          clearTimeout(typingTimer.current);
          typingTimer.current = setTimeout(() => setTyping(false), chat.TYPING_SHOW_MS);
          return;
        }
        if (e.type === "read") return;
        if (e.type === "deleted") {
          if (e.peerIds.includes(contact.peerId)) {
            void listMessages(identity.peerId, contact.peerId).then((m) => alive && setMessages(m));
          }
          return;
        }
        if (e.message.peerId !== contact.peerId || e.message.ownerPeerId !== identity.peerId) return;
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === e.message.id);
          if (i >= 0) return prev.map((m, j) => (j === i ? e.message : m));
          return [...prev, e.message].sort((a, b) => a.sentAt - b.sentAt);
        });
        // A message arriving while this chat is open is read immediately.
        if (e.type === "message" && e.message.direction === "in") {
          setTyping(false);
          void markConversationRead(identity.peerId, contact.peerId).then(() =>
            chat.notifyRead(identity, contact.peerId),
          );
        }
      });
      setPresence((await chat.isConnected(contact.peerId)) ? "online" : "connecting");
      const ok = await chat.connectTo(contact.peerId);
      if (alive) setPresence(ok ? "online" : "offline");
      // Get their latest profile photo straight from their device.
      if (ok) void import("@/lib/p2p/profile-share").then((p) => p.fetchAvatar(identity, contact.peerId));
    })();
    return () => {
      alive = false;
      unsubscribe?.();
      clearTimeout(typingTimer.current);
    };
  }, [identity.peerId, contact.peerId]);

  // Keep the newest message in view.
  useLayoutEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  // Escape closes whatever is on top: dialogs, photo viewer, emoji picker, reply, then the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (actionFor) setActionFor(null);
      else if (confirmBlock) setConfirmBlock(false);
      else if (headMenu) setHeadMenu(false);
      else if (forwarding) setForwarding(null);
      else if (viewer) setViewer(null);
      else if (emojiOpen) setEmojiOpen(false);
      else if (editing) cancelEdit();
      else if (replyTo) setReplyTo(null);
      else onBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack, emojiOpen, viewer, actionFor, forwarding, replyTo, confirmBlock, headMenu, editing]);

  // Stop editing if that message was deleted meanwhile.
  useEffect(() => {
    if (editing && !messages.some((m) => m.id === editing.id && !m.deleted)) cancelEdit();
  }, [messages, editing]);

  /** Blocks or unblocks this contact. It happens on this device only; they aren't told. */
  async function changeBlocked(value: boolean) {
    setConfirmBlock(false);
    setHeadMenu(false);
    const chat = await import("@/lib/p2p/chat");
    await chat.setBlocked(identity, contact.peerId, value);
    setBlocked(value);
    if (value) {
      setReplyTo(null);
      setEmojiOpen(false);
    } else {
      setPresence("connecting");
      setPresence((await chat.connectTo(contact.peerId)) ? "online" : "offline");
    }
  }

  // A short confirmation ("Forwarded to …") clears by itself.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Drop the reply if the message it points at was deleted meanwhile.
  useEffect(() => {
    if (replyTo && !messages.some((m) => m.id === replyTo.id && !m.deleted)) setReplyTo(null);
  }, [messages, replyTo]);

  /** Scrolls to a quoted message and highlights it briefly. */
  function jumpTo(id: string) {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.dataset.flash = "true";
    setTimeout(() => delete el.dataset.flash, 1200);
  }

  function startReply(m: ChatMessage) {
    setActionFor(null);
    setReplyTo(m);
    inputRef.current?.focus();
  }

  async function startForward(m: ChatMessage) {
    setActionFor(null);
    setForwardTargets((await listContacts(identity.peerId)).filter((c) => !c.blocked));
    setForwarding(m);
  }

  /** Sends a copy of the message to another chat, straight from this device. */
  async function forwardTo(target: Contact) {
    const m = forwarding;
    setForwarding(null);
    if (!m) return;
    setError(null);
    try {
      const { sendMessage } = await import("@/lib/p2p/chat");
      await sendMessage(identity, target.peerId, m.text, m.image, m.file, { forwarded: true });
      setNotice(`Forwarded to ${target.handle}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't forward the message.");
    }
  }

  async function remove(m: ChatMessage, everyone: boolean) {
    setActionFor(null);
    const chat = await import("@/lib/p2p/chat");
    if (everyone) await chat.deleteForEveryone(identity, m);
    else await chat.deleteForMe(m);
  }

  const authorOf = (id: string) => (id.startsWith(`${identity.peerId}:`) ? "You" : contact.handle);

  /** Puts one of the user's own messages into the message box to change it. */
  function startEdit(m: ChatMessage) {
    setActionFor(null);
    setReplyTo(null);
    setPhoto(null);
    setDoc(null);
    setEditing(m);
    setText(m.text);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(m.text.length, m.text.length);
    });
  }

  function cancelEdit() {
    setEditing(null);
    setText("");
  }

  async function send() {
    const value = text.trim();
    if (editing) {
      setError(null);
      try {
        const chat = await import("@/lib/p2p/chat");
        await chat.editMessage(identity, editing, value);
        cancelEdit();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't edit the message.");
      }
      return;
    }
    if ((!value && !photo && !doc) || preparing) return;
    setError(null);
    try {
      const { sendMessage, resetTyping } = await import("@/lib/p2p/chat");
      resetTyping(contact.peerId);
      if (doc) {
        // Fingerprint the file so the receiver can check it arrived intact.
        setPreparing(true);
        const { sha256Hex } = await import("@/lib/profile");
        const hash = await sha256Hex(new Uint8Array(await doc.arrayBuffer()));
        await sendMessage(
          identity,
          contact.peerId,
          value,
          undefined,
          { name: safeFileName(doc.name), type: doc.type || "application/octet-stream", size: doc.size, hash, blob: doc },
          { replyTo: replyTo ?? undefined },
        );
      } else {
        await sendMessage(identity, contact.peerId, value, photo ?? undefined, undefined, {
          replyTo: replyTo ?? undefined,
        });
      }
      setReplyTo(null);
      setText("");
      setPhoto(null);
      setDoc(null);
      inputRef.current?.focus();
    } catch (err) {
      setError(
        err instanceof DOMException && err.name === "QuotaExceededError"
          ? "There isn't enough storage space on this device for that file."
          : err instanceof Error
            ? err.message
            : "Couldn't send the message.",
      );
    } finally {
      setPreparing(false);
    }
  }

  const presenceText = blocked
    ? "blocked"
    : network.state !== "online"
      ? "Connecting to the NodeX network…"
      : presence === "online"
        ? typing
          ? "typing…"
          : "online"
        : presence === "connecting"
          ? "connecting…"
          : lastSeen
            ? lastSeenLabel(lastSeen)
            : "offline · messages will be delivered when they're online";

  return (
    <div className="chat">
      <header className="app-bar">
        <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
          <BackIcon />
        </button>
        <Avatar name={contact.handle} size={38} src={avatarUrl} />
        <div className="chat-head">
          <span className="chat-head-name">{contact.handle}</span>
          <span className="chat-head-status" data-presence={blocked ? "blocked" : presence} aria-live="polite">
            {presenceText}
          </span>
        </div>
        <div className="menu">
          <button
            type="button"
            className="icon-btn"
            aria-label="Chat options"
            aria-haspopup="menu"
            aria-expanded={headMenu}
            onClick={() => setHeadMenu((o) => !o)}
          >
            <MoreIcon />
          </button>
          {headMenu && (
            <div className="menu-pop" role="menu">
              {unsaved && !blocked && (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={async () => {
                    setHeadMenu(false);
                    await addContact(identity.peerId, { peerId: contact.peerId, handle: contact.handle });
                    setUnsaved(false);
                    setNotice(`${contact.handle} added to your contacts`);
                    // They may now be allowed to see your photo.
                    void import("@/lib/p2p/profile-share").then((p) => p.pushAvatar(identity));
                  }}
                >
                  Add to contacts
                </button>
              )}
              {blocked ? (
                <button type="button" role="menuitem" className="menu-item" onClick={() => void changeBlocked(false)}>
                  Unblock
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item menu-item-danger"
                  onClick={() => {
                    setHeadMenu(false);
                    setConfirmBlock(true);
                  }}
                >
                  Block
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="chat-messages" ref={listRef} aria-label={`Messages with ${contact.handle}`} role="log">
        <p className="chat-empty">
          {messages.length === 0 &&
            `Messages go directly between your device and ${contact.handle}'s, end-to-end encrypted. No server stores them. `}
          ⏱ Messages disappear 48 hours after they&apos;re read.
        </p>
        {messages.map((m, i) => {
          const showDay = i === 0 || dayLabel(messages[i - 1].sentAt) !== dayLabel(m.sentAt);
          return (
            <div key={m.id}>
              {showDay && <p className="chat-day">{dayLabel(m.sentAt)}</p>}
              <div
                className="bubble"
                data-dir={m.direction}
                data-status={m.status}
                data-photo={!!m.image || !!m.file || undefined}
                data-deleted={m.deleted || undefined}
                data-id={m.id}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setActionFor(m);
                }}
              >
                <button
                  type="button"
                  className="bubble-more"
                  aria-label="Message options"
                  title="Reply, forward or delete"
                  onClick={() => setActionFor(m)}
                >
                  <MoreIcon size={16} />
                </button>
                {m.forwarded && !m.deleted && <span className="bubble-forwarded">↪ Forwarded</span>}
                {m.replyTo && !m.deleted && (
                  <button type="button" className="bubble-quote" onClick={() => jumpTo(m.replyTo!.id)}>
                    <strong>{authorOf(m.replyTo.id)}</strong>
                    <span>{m.replyTo.preview}</span>
                  </button>
                )}
                {m.deleted && <span className="bubble-text bubble-deleted">{messagePreview(m)}</span>}
                {m.image && <MessagePhoto image={m.image} alt={m.text} onOpen={setViewer} />}
                {m.file && <FileAttachment message={m} identity={identity} />}
                {m.text && (
                  <span
                    className="bubble-text"
                    data-jumbo={(!m.image && !m.file && isJumboEmoji(m.text)) || undefined}
                  >
                    {m.text}
                  </span>
                )}
                <span className="bubble-meta">
                  {m.editedAt && !m.deleted && <span className="bubble-edited">edited</span>}
                  {timeLabel(m.sentAt)}
                  {m.direction === "out" && !m.deleted && <MessageTick status={m.status} />}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="search-hint" data-tone="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="search-hint" role="status">
          {notice}
        </p>
      )}
      {editing && (
        <div className="reply-bar">
          <div className="bubble-quote">
            <strong>Editing message</strong>
            <span>{messagePreview(editing)}</span>
          </div>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Cancel editing" onClick={cancelEdit}>
            <CloseIcon size={18} />
          </button>
        </div>
      )}
      {replyTo && (
        <div className="reply-bar">
          <div className="bubble-quote">
            <strong>Replying to {authorOf(replyTo.id) === "You" ? "yourself" : contact.handle}</strong>
            <span>{messagePreview(replyTo)}</span>
          </div>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>
            <CloseIcon size={18} />
          </button>
        </div>
      )}
      {doc && (
        <div className="photo-preview">
          <span className="file-icon" aria-hidden="true">
            {doc.type.startsWith("video/") ? "🎬" : "📄"}
          </span>
          <span className="hint">
            <strong className="file-name">{doc.name}</strong>
            {preparing ? "Preparing file…" : `${formatBytes(doc.size)}. Add a caption or press send.`}
          </span>
          {!preparing && (
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Remove file" onClick={() => setDoc(null)}>
              <CloseIcon size={18} />
            </button>
          )}
        </div>
      )}
      {!doc && (photo || preparing) && (
        <div className="photo-preview">
          {photoUrl ? <img src={photoUrl} alt="Photo to send" /> : <span className="hint">Preparing photo…</span>}
          {photo && (
            <>
              <span className="hint">
                Photo ready · {Math.max(1, Math.round(photo.blob.size / 1024))} KB. Add a caption or press send.
              </span>
              <button type="button" className="icon-btn icon-btn-sm" aria-label="Remove photo" onClick={() => setPhoto(null)}>
                <CloseIcon size={18} />
              </button>
            </>
          )}
        </div>
      )}
      {emojiOpen && !blocked && <EmojiPicker onPick={insertEmoji} />}
      {blocked && (
        <div className="blocked-bar" role="status">
          <span>You blocked this contact. They can&apos;t message you.</span>
          <button type="button" className="link-btn" onClick={() => void changeBlocked(false)}>
            Unblock
          </button>
        </div>
      )}
      <form
        className="composer"
        hidden={blocked}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <button
          type="button"
          className="emoji-toggle"
          aria-label="Attach a photo, video or document"
          title="Attach a photo, video or document"
          hidden={!!editing}
          onClick={() => fileRef.current?.click()}
        >
          <AttachIcon size={22} />
        </button>
        <input
          ref={fileRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // allow picking the same file again
            void attach(file);
          }}
        />
        <button
          type="button"
          className="emoji-toggle"
          aria-label={emojiOpen ? "Close emoji picker" : "Open emoji picker"}
          aria-expanded={emojiOpen}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setEmojiOpen((o) => !o)}
        >
          {emojiOpen ? "⌨️" : "😊"}
        </button>
        <label htmlFor="message" className="sr-only">
          Message
        </label>
        <textarea
          id="message"
          ref={inputRef}
          rows={1}
          autoFocus
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder={editing ? "Edit message" : photo || doc ? "Add a caption…" : "Message"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // Let them see "typing…" (only over an open connection; nothing is stored).
            if (e.target.value.trim() && !editing) {
              void import("@/lib/p2p/chat").then((c) => c.sendTyping(contact.peerId));
            }
          }}
          onPaste={(e) => {
            // Pasting an image (e.g. a screenshot) attaches it as a photo.
            if (editing) return;
            const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
            if (item) {
              e.preventDefault();
              void attach(item.getAsFile());
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="submit"
          className="send-btn"
          aria-label={editing ? "Save edit" : "Send"}
          disabled={editing ? !text.trim() && !editing.image && !editing.file : (!text.trim() && !photo && !doc) || preparing}
        >
          <SendIcon size={22} />
        </button>
      </form>

      {confirmBlock && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setConfirmBlock(false)}>
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="block-title"
            aria-describedby="block-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="block-title">Block {contact.handle}?</h2>
            <p id="block-desc">
              They won&apos;t be able to message you, get your profile photo, or see when you&apos;re online. They won&apos;t be
              told. You can unblock them at any time.
            </p>
            <div className="dialog-actions">
              <button type="button" className="link-btn" autoFocus onClick={() => setConfirmBlock(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void changeBlocked(true)}>
                Block
              </button>
            </div>
          </div>
        </div>
      )}

      {actionFor && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setActionFor(null)}>
          <div
            className="dialog action-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Message options"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="action-preview">{messagePreview(actionFor)}</p>
            {!actionFor.deleted && (
              <>
                <button type="button" className="menu-item" autoFocus onClick={() => startReply(actionFor)}>
                  ↩ Reply
                </button>
                {/* A file can be passed on only once it's on this device. */}
                {(!actionFor.file || actionFor.file.blob) && (
                  <button type="button" className="menu-item" onClick={() => void startForward(actionFor)}>
                    ↪ Forward
                  </button>
                )}
                {actionFor.direction === "out" && !blocked && (
                  <button type="button" className="menu-item" onClick={() => startEdit(actionFor)}>
                    ✏️ Edit
                  </button>
                )}
              </>
            )}
            <button type="button" className="menu-item" onClick={() => void remove(actionFor, false)}>
              🗑 Delete for me
            </button>
            {actionFor.direction === "out" && !actionFor.deleted && (
              <button type="button" className="menu-item menu-item-danger" onClick={() => void remove(actionFor, true)}>
                🗑 Delete for everyone
              </button>
            )}
            <div className="dialog-actions">
              <button type="button" className="link-btn" onClick={() => setActionFor(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {forwarding && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setForwarding(null)}>
          <div
            className="dialog action-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="forward-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="forward-title">Forward to…</h2>
            <p className="action-preview">{messagePreview(forwarding)}</p>
            <ul className="forward-list">
              {forwardTargets.map((c) => (
                <li key={c.peerId}>
                  <button type="button" className="menu-item forward-target" onClick={() => void forwardTo(c)}>
                    <Avatar name={c.handle} size={32} />
                    {c.handle}
                  </button>
                </li>
              ))}
            </ul>
            <div className="dialog-actions">
              <button type="button" className="link-btn" autoFocus onClick={() => setForwarding(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {viewer && (
        <div className="photo-viewer" role="dialog" aria-modal="true" aria-label="Photo" onClick={() => setViewer(null)}>
          <button type="button" className="icon-btn photo-viewer-close" aria-label="Close photo" autoFocus>
            <CloseIcon />
          </button>
          <img src={viewer} alt="Photo" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
