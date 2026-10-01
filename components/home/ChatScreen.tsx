"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Contact } from "@/lib/contacts";
import type { StoredIdentity } from "@/lib/keystore";
import { listMessages, markConversationRead, MAX_MESSAGE_LENGTH, type ChatMessage } from "@/lib/messages";
import type { NetworkStatus } from "@/lib/p2p/node";
import Avatar from "./Avatar";
import { BackIcon, CheckIcon, ClockIcon, DoubleCheckIcon, SendIcon } from "./icons";

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

/** One-to-one chat, delivered directly peer to peer. */
export default function ChatScreen({
  identity,
  contact,
  network,
  onBack,
}: {
  identity: StoredIdentity;
  contact: Contact;
  network: NetworkStatus;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [presence, setPresence] = useState<"online" | "connecting" | "offline">("connecting");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
      unsubscribe = chat.onChatEvent((e) => {
        if (e.type === "presence") {
          if (e.peerId === contact.peerId) setPresence(e.online ? "online" : "offline");
          return;
        }
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
          void markConversationRead(identity.peerId, contact.peerId).then(() =>
            chat.notifyRead(identity, contact.peerId),
          );
        }
      });
      setPresence((await chat.isConnected(contact.peerId)) ? "online" : "connecting");
      const ok = await chat.connectTo(contact.peerId);
      if (alive) setPresence(ok ? "online" : "offline");
    })();
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [identity.peerId, contact.peerId]);

  // Keep the newest message in view.
  useLayoutEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);

  async function send() {
    const value = text.trim();
    if (!value) return;
    setError(null);
    try {
      const { sendMessage } = await import("@/lib/p2p/chat");
      await sendMessage(identity, contact.peerId, value);
      setText("");
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the message.");
    }
  }

  const presenceText =
    network.state !== "online"
      ? "Connecting to the NodeX network…"
      : presence === "online"
        ? "online"
        : presence === "connecting"
          ? "connecting…"
          : "offline · messages will be delivered when they're online";

  return (
    <div className="chat">
      <header className="app-bar">
        <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
          <BackIcon />
        </button>
        <Avatar name={contact.handle} size={38} />
        <div className="chat-head">
          <span className="chat-head-name">{contact.handle}</span>
          <span className="chat-head-status" data-presence={presence} aria-live="polite">
            {presenceText}
          </span>
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
              <div className="bubble" data-dir={m.direction} data-status={m.status}>
                <span className="bubble-text">{m.text}</span>
                <span className="bubble-meta">
                  {timeLabel(m.sentAt)}
                  {m.direction === "out" && <MessageTick status={m.status} />}
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
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="message" className="sr-only">
          Message
        </label>
        <textarea
          id="message"
          ref={inputRef}
          rows={1}
          autoFocus
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder="Message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" className="send-btn" aria-label="Send" disabled={!text.trim()}>
          <SendIcon size={22} />
        </button>
      </form>
    </div>
  );
}
