"use client";

import { useEffect, useRef, useState } from "react";
import type { StoredIdentity } from "@/lib/keystore";
import { removeAvatar, setAvatar } from "@/lib/profile";
import Avatar from "./Avatar";
import { BackIcon, CameraIcon } from "./icons";

/** Profile: the handle (the user's identity) and a photo kept on this device. */
export default function ProfileScreen({
  identity,
  avatarUrl,
  onAvatarChange,
  onBack,
}: {
  identity: StoredIdentity;
  avatarUrl?: string;
  onAvatarChange: (avatar: Blob | undefined) => void;
  onBack: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const { toAvatarImage } = await import("@/lib/image");
      const image = await toAvatarImage(file);
      await setAvatar(identity.peerId, image);
      onAvatarChange(image);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't use that photo. Try another one.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    await removeAvatar(identity.peerId);
    onAvatarChange(undefined);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(identity.handle);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable; the handle stays selectable.
    }
  }

  return (
    <>
      <header className="app-bar">
        <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
          <BackIcon />
        </button>
        <div className="app-title">
          <span>Profile</span>
        </div>
      </header>

      <div className="profile">
        <div className="profile-photo">
          <Avatar name={identity.handle} size={148} src={avatarUrl} />
          <button
            type="button"
            className="profile-camera"
            aria-label={avatarUrl ? "Change profile photo" : "Add profile photo"}
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            <CameraIcon size={22} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={onFile}
          />
        </div>

        {error && (
          <p className="search-hint" data-tone="error" role="alert">
            {error}
          </p>
        )}
        {avatarUrl && !busy && (
          <button type="button" className="link-btn profile-remove" onClick={remove}>
            Remove photo
          </button>
        )}

        <dl className="profile-fields">
          <div>
            <dt>Your NodeX handle</dt>
            <dd className="profile-handle">
              <span data-testid="profile-handle">{identity.handle}</span>
              <button type="button" className="link-btn" onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </button>
            </dd>
          </div>
        </dl>
        <p className="hint profile-note">
          This is your username/handle. Share it so people can find you on NodeX. Your photo is stored on this device
          and is shared only directly with the people you connect to.
        </p>
      </div>
    </>
  );
}
