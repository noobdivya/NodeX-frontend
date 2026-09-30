"use client";

import { useState } from "react";

/** Shows the 12-word recovery phrase once. It is never stored or sent anywhere. */
export default function RecoveryPhraseStep({ phrase, onConfirmed }: { phrase: string; onConfirmed: () => void }) {
  const [saved, setSaved] = useState(false);
  const words = phrase.split(" ");

  return (
    <>
      <h1>Save your recovery phrase</h1>
      <p className="lead">
        Write these 12 words down in order and keep them somewhere safe. With your email and handle, they&apos;re
        the only way to log in again or on a new device. They&apos;re never stored anywhere, so no one can recover
        them for you.
      </p>

      <ol className="phrase" aria-label="Recovery phrase">
        {words.map((w, i) => (
          <li key={i}>
            <span>{i + 1}</span>
            {w}
          </li>
        ))}
      </ol>

      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I&apos;ve written down my recovery phrase
      </label>

      <button className="btn" type="button" disabled={!saved} onClick={onConfirmed}>
        Continue
      </button>
    </>
  );
}
