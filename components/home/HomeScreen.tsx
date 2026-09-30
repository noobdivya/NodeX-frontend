"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { listContacts, type Contact } from "@/lib/contacts";
import { clearIdentity, getIdentity, type StoredIdentity } from "@/lib/keystore";
import { getAvatar } from "@/lib/profile";
import Avatar from "./Avatar";
import ProfileScreen from "./ProfileScreen";
import { MoreIcon } from "./icons";

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
  const [view, setView] = useState<"contacts" | "profile">("contacts");
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const avatarUrl = useObjectUrl(avatar);

  // Logged in means an identity exists on this device.
  useEffect(() => {
    getIdentity()
      .then(async (record) => {
        if (!record) {
          router.replace("/login");
          return;
        }
        setIdentity(record);
        setAvatar(await getAvatar(record.peerId));
        setContacts(await listContacts(record.peerId));
      })
      .catch(() => router.replace("/login"));
  }, [router]);

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
    await clearIdentity();
    router.replace("/login");
  }, [router]);

  if (!identity) {
    return (
      <div className="app">
        <p className="app-empty">Loading…</p>
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

      {contacts.length === 0 ? (
        <div className="app-empty">
          <p>No contacts yet</p>
          <span>
            You&apos;ll find people by their handle, like Rahul#7K3M9X, directly over the NodeX peer-to-peer network.
          </span>
        </div>
      ) : (
        <ul className="chat-list" aria-label="Contacts">
          {contacts.map((c) => (
            <li key={c.peerId} className="chat-row">
              <Avatar name={c.handle} />
              <div className="chat-main">
                <span className="chat-name">{c.handle}</span>
                <span className="chat-sub">{addedLabel(c.addedAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

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
