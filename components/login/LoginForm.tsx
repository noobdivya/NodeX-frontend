"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Re-login / account recovery, entirely on this device: the 12 words
 * recreate the private key, and the email + handle must re-derive to the
 * same handle. No server is contacted and no new identity is created.
 */
export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [handle, setHandle] = useState("");
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Already logged in on this device? Go straight to the app.
  useEffect(() => {
    import("@/lib/keystore").then(({ getIdentity }) =>
      getIdentity().then((id) => {
        if (id) router.replace("/home");
      }),
    );
  }, [router]);

  const wordCount = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
  const canSubmit = email.trim() !== "" && handle.trim() !== "" && wordCount === 12 && !status;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setStatus("Restoring your identity…");
    try {
      const [identityLib, keystore] = await Promise.all([import("@/lib/identity"), import("@/lib/keystore")]);
      const restored = await identityLib.restoreIdentity({ email, handle, phrase });

      setStatus("Securing your identity on this device…");
      const privateKey = identityLib.exportPrivateKey(restored);
      try {
        await keystore.saveIdentity({
          peerId: restored.peerId,
          handle: restored.handle,
          handleKey: restored.handleKey,
          publicKey: restored.publicKey,
          emailCommitment: restored.emailCommitment,
          privateKey,
        });
      } finally {
        privateKey.fill(0);
      }
      router.replace("/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setStatus(null);
    }
  }

  return (
    <div className="card">
      <Link href="/" className="brand">
        <img src="/icon.svg" alt="" />
        NodeX
      </Link>

      <h1>Log in to NodeX</h1>
      <p className="lead">
        Enter your email, your handle and your 12-word recovery phrase. Everything is checked on this device.
      </p>

      <form onSubmit={submit} noValidate>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            maxLength={254}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            placeholder="you@example.com"
          />
        </div>
        <div className="field">
          <label htmlFor="handle">Handle</label>
          <input
            id="handle"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={27}
            value={handle}
            onChange={(e) => {
              setHandle(e.target.value);
              setError(null);
            }}
            placeholder="Rahul#7K3M9X"
          />
        </div>
        <div className="field">
          <label htmlFor="phrase">Recovery phrase</label>
          <textarea
            id="phrase"
            className="phrase-input"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={phrase}
            onChange={(e) => {
              setPhrase(e.target.value);
              setError(null);
            }}
            placeholder="word1 word2 word3 …"
            aria-describedby="phrase-hint"
          />
          <span id="phrase-hint" className="hint">
            {wordCount}/12 words. Your phrase never leaves this device.
          </span>
        </div>
        <button className="btn" type="submit" disabled={!canSubmit}>
          {status ?? "Log in"}
        </button>
      </form>

      <p className="muted-foot">
        New to NodeX? <Link href="/register">Create your identity</Link>
      </p>
    </div>
  );
}
