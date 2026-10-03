"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { addContact, getContact, listContacts, removeContact, type Contact } from "@/lib/contacts";
import { clearIdentity, getIdentity, type StoredIdentity } from "@/lib/keystore";
import { listConversations, messagePreview, type ChatMessage, type ConversationSummary } from "@/lib/messages";
import {
  disableNotifications,
  enableNotifications,
  notificationsUndecided,
  notifyMessage,
  notifyState,
  type NotifyState,
} from "@/lib/notifications";
import type { LookupResult, NetworkStatus } from "@/lib/p2p/node";
import { getAvatar } from "@/lib/profile";
import Avatar from "./Avatar";
import ChatScreen from "./ChatScreen";
import ContactSearch from "./ContactSearch";
import ProfileScreen from "./ProfileScreen";
import { MessageTick } from "./ChatScreen";
import { MoreIcon, PlusMessageIcon } from "./icons";
import { useAvatarUrls } from "./useAvatarUrls";

const PURGE_INTERVAL_MS = 60_000;

/** WhatsApp-style time for the chat list: time today, "Yesterday", else date. */
function listTime(ms: number): string {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function networkLabel(s: NetworkStatus): string {
  switch (s.state) {
    case "online":
      return s.published ? "Online · discoverable on the NodeX network" : "Online · publishing your handle…";
    case "unconfigured":
      return "No NodeX network nodes configured";
    case "offline":
      return "Offline · can't reach the NodeX network";
    default:
      return "Connecting to the NodeX network…";
  }
}

function addedLabel(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "Added today";
  if (days === 1) return "Added yesterday";
  return `Added ${new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** Object URL for a Blob, revoked when it changes or the component unmounts. */
function useObjectUrl(blob: Blob | undefined): string | undefined {
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

export default function HomeScreen() {
  const router = useRouter();
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [avatar, setAvatar] = useState<Blob>();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [view, setView] = useState<"contacts" | "profile" | "search" | "chat">("contacts");
  const [chatWith, setChatWith] = useState<Contact | null>(null);
  const [summaries, setSummaries] = useState<Map<string, ConversationSummary>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [network, setNetwork] = useState<NetworkStatus>({ state: "starting", peers: 0, published: false });
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const avatarUrl = useObjectUrl(avatar);
  // Contacts' photos, received peer to peer and kept on this device.
  const contactAvatars = useAvatarUrls(contacts.map((c) => c.peerId));

  // Logged in means an identity exists on this device. Only a missing
  // identity sends the user to /login; other load failures are shown here
  // (redirecting on them would loop, since /login sends logged-in users back).
  useEffect(() => {
    let alive = true;
    (async () => {
      let record: StoredIdentity | undefined;
      try {
        record = await getIdentity();
      } catch (err) {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
        return;
      }
      if (!alive) return;
      if (!record) {
        router.replace("/login");
        return;
      }
      setIdentity(record);
      try {
        setAvatar(await getAvatar(record.peerId));
        setContacts(await listContacts(record.peerId));
        setSummaries(await listConversations(record.peerId));
      } catch (err) {
        console.error("NodeX: couldn't load local data", err);
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  // Notifications for messages that arrive while NodeX is in the background.
  const [notify, setNotify] = useState<NotifyState>("off");
  const [offerNotify, setOfferNotify] = useState(false);
  useEffect(() => {
    setNotify(notifyState());
    setOfferNotify(notificationsUndecided());
  }, []);

  const announce = useCallback(
    async (m: ChatMessage) => {
      if (!identity) return;
      const contact = await getContact(identity.peerId, m.peerId);
      if (!contact || contact.blocked) return;
      notifyMessage(contact.handle, messagePreview(m), m.peerId, () => {
        setChatWith(contact);
        setView("chat");
      });
    },
    [identity],
  );

  // Unread count in the tab title, e.g. "(2) NodeX".
  useEffect(() => {
    // The page's own title may not be set yet on first load, hence the fallback.
    const base = document.title.replace(/^\(\d+\)\s*/, "") || "NodeX";
    let unread = 0;
    for (const s of summaries.values()) unread += s.unread;
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
  }, [summaries, view]);

  const refreshChats = useCallback(async () => {
    if (!identity) return;
    try {
      setContacts(await listContacts(identity.peerId));
      setSummaries(await listConversations(identity.peerId));
    } catch (err) {
      console.error("NodeX: couldn't refresh chats", err);
    }
  }, [identity]);

  // Join the P2P network (chat handler included) and publish this user's handle.
  useEffect(() => {
    if (!identity) return;
    let unsubscribeStatus: (() => void) | undefined;
    let unsubscribeChat: (() => void) | undefined;
    let purgeTimer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;
    // Load chat first: it registers its protocol handler for when the node starts.
    Promise.all([
      import("@/lib/p2p/chat"),
      import("@/lib/p2p/node"),
      import("@/lib/p2p/profile-share"), // registers the photo-sharing protocol
      import("@/lib/p2p/file-transfer"), // registers the video/document transfer protocol
    ]).then(([chat, { onStatus, startNetwork }]) => {
      if (cancelled) return;
      unsubscribeStatus = onStatus(setNetwork);
      unsubscribeChat = chat.onChatEvent((e) => {
        if (e.type !== "presence") void refreshChats();
        if (e.type === "message" && e.message.direction === "in") void announce(e.message);
      });
      // Disappearing messages: delete anything read more than 48 hours ago.
      const purge = () => void chat.purgeExpired(identity).catch(() => {});
      purge();
      purgeTimer = setInterval(purge, PURGE_INTERVAL_MS);
      startNetwork(identity).catch(() => {});
    });
    return () => {
      cancelled = true;
      clearInterval(purgeTimer);
      unsubscribeStatus?.();
      unsubscribeChat?.();
    };
  }, [identity, refreshChats, announce]);

  // Close the menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const logout = useCallback(async () => {
    await import("@/lib/p2p/node").then(({ stopNetwork }) => stopNetwork()).catch(() => {});
    await clearIdentity();
    router.replace("/login");
  }, [router]);

  async function add(result: LookupResult) {
    if (!identity) return;
    await addContact(identity.peerId, { peerId: result.peerId, handle: result.handle });
    setContacts(await listContacts(identity.peerId));
  }

  /** From a search result straight into the chat; the person is saved as a contact. */
  async function openChatFromSearch(result: LookupResult) {
    if (!identity) return;
    let contact = (await listContacts(identity.peerId)).find((c) => c.peerId === result.peerId);
    if (!contact) {
      await addContact(identity.peerId, { peerId: result.peerId, handle: result.handle });
      contact = (await listContacts(identity.peerId)).find((c) => c.peerId === result.peerId);
    }
    if (!contact) return;
    setContacts(await listContacts(identity.peerId));
    setChatWith(contact);
    setView("chat");
  }

  async function remove(peerId: string) {
    if (!identity) return;
    await removeContact(identity.peerId, peerId);
    setContacts(await listContacts(identity.peerId));
  }

  if (!identity) {
    return (
      <div className="app">
        {loadError ? (
          <div className="app-empty" role="alert">
            <p>Couldn&apos;t open NodeX&apos;s storage on this device</p>
            <span>{loadError}</span>
          </div>
        ) : (
          <p className="app-empty">Loading…</p>
        )}
      </div>
    );
  }

  if (view === "chat" && chatWith) {
    return (
      <div className="app app-chat">
        <ChatScreen
          identity={identity}
          contact={chatWith}
          avatarUrl={contactAvatars.get(chatWith.peerId)}
          network={network}
          onBack={() => {
            setView("contacts");
            setChatWith(null);
            void refreshChats();
          }}
        />
      </div>
    );
  }

  if (view === "search") {
    return (
      <div className="app">
        <ContactSearch
          identity={identity}
          network={network}
          savedPeerIds={new Set(contacts.map((c) => c.peerId))}
          onAdd={add}
          onRemove={remove}
          onMessage={(result) => void openChatFromSearch(result)}
          onBack={() => setView("contacts")}
        />
      </div>
    );
  }

  if (view === "profile") {
    return (
      <div className="app">
        <ProfileScreen
          identity={identity}
          avatarUrl={avatarUrl}
          onAvatarChange={setAvatar}
          onBack={() => setView("contacts")}
        />
      </div>
    );
  }

  const openProfile = () => {
    setMenuOpen(false);
    setView("profile");
  };

  return (
    <div className="app">
      <header className="app-bar">
        <div className="app-title">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>NodeX</span>
        </div>
        <div className="menu" ref={menuRef}>
          <button
            type="button"
            className="icon-btn"
            aria-label="Menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <MoreIcon />
          </button>
          {menuOpen && (
            <div className="menu-pop" role="menu">
              <button type="button" role="menuitem" className="menu-profile" onClick={openProfile}>
                <Avatar name={identity.handle} size={40} src={avatarUrl} />
                <div>
                  <strong className="menu-handle">{identity.handle}</strong>
                  <span>Your NodeX handle</span>
                </div>
              </button>
              <button type="button" role="menuitem" className="menu-item" onClick={openProfile}>
                Profile
              </button>
              {notify !== "unsupported" && (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  disabled={notify === "denied"}
                  onClick={async () => {
                    setOfferNotify(false);
                    setNotify(notify === "on" ? disableNotifications() : await enableNotifications());
                  }}
                >
                  {notify === "on"
                    ? "Turn off notifications"
                    : notify === "denied"
                      ? "Notifications are blocked in your browser settings"
                      : "Turn on notifications"}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmLogout(true);
                }}
              >
                Log out
              </button>
            </div>
          )}
        </div>
      </header>

      <h1 className="sr-only">NodeX, logged in as {identity.handle}</h1>

      <p className="net-status" data-state={network.state} role="status" aria-live="polite">
        <span className="net-dot" aria-hidden="true" />
        {networkLabel(network)}
      </p>
      {offerNotify && (
        <p className="notify-banner">
          <span>Get notified about new messages while NodeX is open in the background.</span>
          <span>
            <button
              type="button"
              className="link-btn"
              onClick={async () => {
                setOfferNotify(false);
                setNotify(await enableNotifications());
              }}
            >
              Turn on
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setOfferNotify(false);
                setNotify(disableNotifications());
              }}
            >
              Not now
            </button>
          </span>
        </p>
      )}
      {loadError && (
        <p className="search-hint" data-tone="error" role="alert">
          Some local data couldn&apos;t be loaded: {loadError}
        </p>
      )}

      {contacts.length === 0 ? (
        <div className="app-empty">
          <p>No contacts yet</p>
          <span>Tap the + button to find people by their handle, like Rahul#7K3M9X.</span>
        </div>
      ) : (
        <ul className="chat-list" aria-label="Contacts">
          {[...contacts]
            .sort(
              (a, b) =>
                (summaries.get(b.peerId)?.last.sentAt ?? Date.parse(b.addedAt)) -
                (summaries.get(a.peerId)?.last.sentAt ?? Date.parse(a.addedAt)),
            )
            .map((c) => {
              const s = summaries.get(c.peerId);
              return (
                <li key={c.peerId}>
                  <button
                    type="button"
                    className="chat-row chat-row-btn"
                    aria-label={`Chat with ${c.handle}${s?.unread ? `, ${s.unread} unread` : ""}`}
                    onClick={() => {
                      setChatWith(c);
                      setView("chat");
                    }}
                  >
                    <Avatar name={c.handle} src={contactAvatars.get(c.peerId)} />
                    <div className="chat-main">
                      <span className="chat-name">{c.handle}</span>
                      <span className="chat-sub">
                        {s ? (
                          <>
                            {s.last.direction === "out" && !s.last.deleted && (
                              <span className="chat-sub-tick">
                                <MessageTick status={s.last.status} />
                              </span>
                            )}
                            {messagePreview(s.last)}
                          </>
                        ) : (
                          addedLabel(c.addedAt)
                        )}
                      </span>
                    </div>
                    {c.blocked && <span className="chat-blocked">Blocked</span>}
                    {s && (
                      <div className="chat-side">
                        <span className="chat-time" data-unread={s.unread > 0}>
                          {listTime(s.last.sentAt)}
                        </span>
                        {s.unread > 0 && <span className="unread-badge">{s.unread}</span>}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
        </ul>
      )}

      <button type="button" className="fab" aria-label="New contact" onClick={() => setView("search")}>
        <PlusMessageIcon size={26} />
      </button>

      {confirmLogout && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setConfirmLogout(false)}>
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="logout-title"
            aria-describedby="logout-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="logout-title">Log out of NodeX?</h2>
            <p id="logout-desc">
              Your identity will be removed from this device. To log back in you&apos;ll need your email, your handle{" "}
              <strong>{identity.handle}</strong> and your 12-word recovery phrase.
            </p>
            <div className="dialog-actions">
              <button type="button" className="link-btn" autoFocus onClick={() => setConfirmLogout(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={logout}>
                Log out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
