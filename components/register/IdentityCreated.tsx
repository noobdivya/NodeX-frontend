"use client";

import { useState } from "react";
import type { RegisteredUser } from "@/lib/api";

export default function IdentityCreated({ user }: { user: RegisteredUser }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(user.peer_id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (e.g. insecure context); the ID stays selectable.
    }
  }

  return (
    <>
      <h1>Your identity is ready</h1>
      <p className="lead">Welcome to NodeX, {user.username}.</p>

      <dl className="identity">
        <div>
          <dt>Username</dt>
          <dd>{user.username}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{user.email}</dd>
        </div>
        <div>
          <dt>Peer ID</dt>
          <dd className="peer-id">
            <span>{user.peer_id}</span>
            <button type="button" className="link-btn" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </dd>
        </div>
      </dl>

      <div className="alert" data-tone="info">
        Your private key was generated on this device and is stored here, encrypted with your password. It was never
        sent to NodeX servers.
      </div>
    </>
  );
}
