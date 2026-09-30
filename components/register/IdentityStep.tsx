"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Shows the newly generated handle, which is now the user's only username. */
export default function IdentityStep({ handle }: { handle: string }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(handle);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable; the handle stays selectable.
    }
  }

  return (
    <>
      <h1>Your NodeX identity</h1>
      <div className="handle-card">
        <span className="handle-text" data-testid="handle">
          {handle}
        </span>
        <button type="button" className="link-btn" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="alert" data-tone="info" role="status">
        This is your username/handle. Use this identity to find other users and to identify yourself on NodeX.
      </div>
      <p className="hint handle-note">
        To log in again, you&apos;ll need your email, this handle and your 12-word recovery phrase.
      </p>
      <button className="btn" type="button" onClick={() => router.replace("/home")}>
        Continue to NodeX
      </button>
    </>
  );
}
