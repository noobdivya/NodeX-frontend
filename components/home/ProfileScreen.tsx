"use client";

import { useEffect, useRef, useState } from "react";
import type { StoredIdentity } from "@/lib/keystore";
import {
  getPhotoVisibility,
  removeAvatar,
  setAvatar,
  setPhotoVisibility,
  type PhotoVisibility,
} from "@/lib/profile";
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
  const [visibility, setVisibility] = useState<PhotoVisibility>("everyone");

  useEffect(() => {
    void getPhotoVisibility(identity.peerId).then(setVisibility);
  }, [identity.peerId]);

  async function changeVisibility(v: PhotoVisibility) {
    setVisibility(v);
    await setPhotoVisibility(identity.peerId, v);
    // Tell everyone connected right now: allowed people get the photo, others "no photo".
    void import("@/lib/p2p/profile-share").then((p) => p.pushAvatar(identity));
  }

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
      // Send the new photo straight to everyone currently connected.
      void import("@/lib/p2p/profile-share").then((p) => p.pushAvatar(identity));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't use that photo. Try another one.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    await removeAvatar(identity.peerId);
    onAvatarChange(undefined);
    void import("@/lib/p2p/profile-share").then((p) => p.pushAvatar(identity));
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
          This is your username/handle. Share it so people can find you on NodeX.
        </p>

        <fieldset className="profile-privacy">
          <legend>Who can see my profile photo</legend>
          <label>
            <input
              type="radio"
              name="photo-visibility"
              checked={visibility === "everyone"}
              onChange={() => void changeVisibility("everyone")}
            />
            Everyone who finds or chats with me
          </label>
          <label>
            <input
              type="radio"
              name="photo-visibility"
              checked={visibility === "contacts"}
              onChange={() => void changeVisibility("contacts")}
            />
            My contacts only
          </label>
          <span className="hint">
            {visibility === "contacts"
              ? "Only people you added yourself get your photo. People who just messaged you don't."
              : "Your photo goes straight from your device to theirs, never to a server."}
          </span>
        </fieldset>
      </div>
    </>
  );
}
