"use client";

import { useState } from "react";
import { DISPLAY_NAME_RE } from "@/lib/handle";
import type { NodeXIdentity } from "@/lib/identity";

/**
 * Asks for a display name and generates the cryptographic identity on this
 * device. The name only seeds the handle ("Rahul" → "Rahul#7K3M9X").
 */
export default function NameStep({
  email,
  onCreated,
}: {
  email: string;
  onCreated: (identity: NodeXIdentity, recoveryPhrase: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const valid = DISPLAY_NAME_RE.test(name.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || status) return;
    setError(null);
    try {
      // Crypto code is loaded on demand to keep the first page light.
      const [identityLib, keystore] = await Promise.all([import("@/lib/identity"), import("@/lib/keystore")]);

      setStatus("Generating your cryptographic identity…");
      const created = await identityLib.createIdentity(name, email);

      setStatus("Securing your identity on this device…");
      const privateKey = identityLib.exportPrivateKey(created);
      try {
        await keystore.saveIdentity({
          peerId: created.peerId,
          handle: created.handle,
          handleKey: created.handleKey,
          publicKey: created.publicKey,
          emailCommitment: created.emailCommitment,
          privateKey,
        });
      } finally {
        privateKey.fill(0);
      }
      onCreated(created, created.recoveryPhrase);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setStatus(null);
    }
  }

  return (
    <>
      <h1>Choose a display name</h1>
      <p className="lead">
        Email verified: <strong>{email}</strong>. Your display name is used once to generate your unique NodeX
        handle, like <strong>Rahul#7K3M9X</strong>.
      </p>

      <form onSubmit={submit} noValidate>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="display-name">Display name</label>
          <input
            id="display-name"
            autoComplete="nickname"
            autoCapitalize="words"
            spellCheck={false}
            autoFocus
            maxLength={20}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!!name && !valid}
            aria-describedby="name-hint"
          />
          <span id="name-hint" className="hint" data-tone={name && !valid ? "error" : undefined}>
            2–20 letters, numbers, or underscores.
          </span>
        </div>
        <button className="btn" type="submit" disabled={!valid || !!status}>
          {status ?? "Generate my identity"}
        </button>
      </form>
    </>
  );
}
